import { readdir, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import type { SessionMeta, ParsedSessionMeta, AgentMessage, SessionTree } from '$lib/types';
import { getMetaStmt, upsertMetaStmt } from './cache';
import { buildSessionTree, getPathToNode } from './session-tree';
import { getMsgsStmt, upsertMsgsStmt } from './cache';

const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');

// --- Encoding ---

export function encodeSessionId(filePath: string): string {
	return Buffer.from(filePath).toString('base64url');
}

export function decodeSessionId(id: string): string {
	const filePath = Buffer.from(id, 'base64url').toString();
	const resolved = resolve(filePath);
	if (!resolved.startsWith(SESSIONS_DIR)) {
		throw new Error('Invalid session ID: path outside sessions directory');
	}
	return resolved;
}

// --- File scanning ---

interface FileInfo {
	path: string;
	mtime: number;
	size: number;
}

async function scanSessionFiles(): Promise<FileInfo[]> {
	const results: FileInfo[] = [];
	try {
		const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(SESSIONS_DIR, entry.name);
			try {
				const files = await readdir(dirPath);
				for (const file of files) {
					if (!file.endsWith('.jsonl')) continue;
					const filePath = join(dirPath, file);
					try {
						const s = await stat(filePath);
						results.push({ path: filePath, mtime: Math.floor(s.mtimeMs), size: s.size });
					} catch {
						/* skip unreadable files */
					}
				}
			} catch {
				/* skip unreadable dirs */
			}
		}
	} catch {
		/* sessions dir doesn't exist yet */
	}
	return results;
}

// --- JSONL parsing ---

export async function parseSessionMetadata(filePath: string): Promise<ParsedSessionMeta> {
	const s = await stat(filePath);
	const text = await Bun.file(filePath).text();
	const lines = text.split('\n');

	let cwd = '';
	let name: string | null = null;
	let firstMessage = '';
	let model: string | null = null;
	let messageCount = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			switch (entry.type) {
				case 'session':
					cwd = entry.cwd || '';
					break;
				case 'session_info':
					if (entry.name) name = entry.name;
					break;
				case 'model_change':
					model = entry.modelId
						? `${entry.provider ? entry.provider + '/' : ''}${entry.modelId}`
						: null;
					break;
				case 'message':
					messageCount++;
					if (
						!firstMessage &&
						entry.message?.role === 'user' &&
						entry.message?.content
					) {
						const textContent = entry.message.content.find(
							(c: any) => c.type === 'text'
						);
						if (textContent?.text) {
							firstMessage = textContent.text.slice(0, 200);
						}
					}
					break;
			}
		} catch {
			/* skip malformed lines */
		}
	}

	// Extract createdAt from filename: timestamp_uuid.jsonl
	const filename = basename(filePath);
	const createdAt = filename.split('_')[0] || new Date(s.mtimeMs).toISOString();

	return {
		id: encodeSessionId(filePath),
		filePath,
		cwd,
		name,
		firstMessage: firstMessage || '(empty session)',
		lastModified: new Date(s.mtimeMs),
		messageCount,
		model,
		mtime: Math.floor(s.mtimeMs),
		size: s.size,
		createdAt
	};
}

export async function parseJSONLFile(filePath: string): Promise<AgentMessage[]> {
	const text = await Bun.file(filePath).text();
	const entries: AgentMessage[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* skip malformed */
		}
	}
	return entries;
}

// --- Tail reading (fast — reads last N bytes of file) ---

export async function getTailMessages(
	filePath: string,
	count: number = 20,
	chunkSize: number = 64 * 1024
): Promise<{ messages: AgentMessage[]; hasMore: boolean }> {
	const file = Bun.file(filePath);
	const size = file.size;

	if (size === 0) return { messages: [], hasMore: false };

	// Read last chunk
	const readSize = Math.min(chunkSize, size);
	const start = size - readSize;
	const blob = file.slice(start, size);
	const text = await blob.text();

	// Parse lines from the chunk
	const lines = text.split('\n');
	// First line may be partial if we didn't start at 0
	if (start > 0) lines.shift();

	const entries: AgentMessage[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			// Only include renderable entries
			if (entry.type === 'message' || entry.type === 'compaction') {
				entries.push(entry);
			}
		} catch {
			/* skip */
		}
	}

	// Take last N
	const tail = entries.slice(-count);
	const hasMore = start > 0 || entries.length > count;

	return { messages: tail, hasMore };
}

// --- Cache types ---

interface CachedMeta {
	file_path: string;
	mtime_ms: number;
	size_bytes: number;
	cwd: string;
	name: string | null;
	first_message: string | null;
	model: string | null;
	message_count: number;
	last_modified: string;
	created_at: string;
}

interface CachedMessages {
	file_path: string;
	mtime_ms: number;
	size_bytes: number;
	messages_json: string;
	tree_json: string;
}

function cachedToMeta(row: CachedMeta): SessionMeta {
	return {
		id: encodeSessionId(row.file_path),
		filePath: row.file_path,
		cwd: row.cwd,
		name: row.name,
		firstMessage: row.first_message || '(empty session)',
		lastModified: new Date(row.last_modified),
		messageCount: row.message_count,
		model: row.model
	};
}

// --- Public API ---

export async function listSessions(): Promise<SessionMeta[]> {
	const files = await scanSessionFiles();
	const results: SessionMeta[] = [];
	const stale: string[] = [];
	const gStmt = getMetaStmt();
	const uStmt = upsertMetaStmt();

	for (const file of files) {
		const cached = gStmt.get(file.path) as CachedMeta | null;

		if (cached && cached.mtime_ms === file.mtime && cached.size_bytes === file.size) {
			results.push(cachedToMeta(cached));
		} else if (cached) {
			results.push(cachedToMeta(cached));
			stale.push(file.path);
		} else {
			try {
				const meta = await parseSessionMetadata(file.path);
				uStmt.run(
					file.path,
					meta.mtime,
					meta.size,
					meta.cwd,
					meta.name,
					meta.firstMessage,
					meta.model,
					meta.messageCount,
					meta.lastModified.toISOString(),
					meta.createdAt
				);
				results.push(meta);
			} catch {
				/* skip unparseable */
			}
		}
	}

	if (stale.length > 0) {
		refreshStaleEntries(stale);
	}

	return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

async function refreshStaleEntries(paths: string[]) {
	const uStmt = upsertMetaStmt();
	for (const path of paths) {
		try {
			const meta = await parseSessionMetadata(path);
			uStmt.run(
				path,
				meta.mtime,
				meta.size,
				meta.cwd,
				meta.name,
				meta.firstMessage,
				meta.model,
				meta.messageCount,
				meta.lastModified.toISOString(),
				meta.createdAt
			);
		} catch {
			/* skip */
		}
	}
}

export async function getSessionMessages(
	filePath: string
): Promise<{ messages: AgentMessage[]; tree: SessionTree }> {
	const s = await stat(filePath);
	const mtime = Math.floor(s.mtimeMs);
	const size = s.size;
	const cached = getMsgsStmt().get(filePath) as CachedMessages | null;

	if (cached && cached.mtime_ms === mtime && cached.size_bytes === size) {
		return {
			messages: JSON.parse(cached.messages_json),
			tree: JSON.parse(cached.tree_json)
		};
	}

	const entries = await parseJSONLFile(filePath);
	const tree = buildSessionTree(entries);
	const messages = getPathToNode(tree, tree.currentLeaf);

	upsertMsgsStmt().run(filePath, mtime, size, JSON.stringify(messages), JSON.stringify(tree));

	return { messages, tree };
}

export async function warmAllSessions(): Promise<void> {
	const files = await scanSessionFiles();
	const gStmt = getMetaStmt();
	const uStmt = upsertMetaStmt();
	for (const file of files) {
		const cached = gStmt.get(file.path) as CachedMeta | null;
		if (!cached || cached.mtime_ms !== file.mtime || cached.size_bytes !== file.size) {
			try {
				const meta = await parseSessionMetadata(file.path);
				uStmt.run(
					file.path,
					meta.mtime,
					meta.size,
					meta.cwd,
					meta.name,
					meta.firstMessage,
					meta.model,
					meta.messageCount,
					meta.lastModified.toISOString(),
					meta.createdAt
				);
			} catch {
				/* skip */
			}
		}
	}
	console.log(`Cache warmed: ${files.length} sessions`);
}
