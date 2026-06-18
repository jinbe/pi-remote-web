import { readdir, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import type { SessionMeta, ParsedSessionMeta, AgentMessage, SessionTree } from '$lib/types';
import { getMetaStmt, upsertMetaStmt } from './cache';
import { buildSessionTree, getPathToNode } from './session-tree';
import { getMsgsStmt, upsertMsgsStmt } from './cache';

const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');
const CLAUDE_SESSIONS_DIR = join(homedir(), '.claude', 'projects');

/** All allowed session root directories for path validation */
const ALLOWED_SESSION_DIRS = [SESSIONS_DIR, CLAUDE_SESSIONS_DIR];

// --- Encoding ---

export function encodeSessionId(filePath: string): string {
	return Buffer.from(filePath).toString('base64url');
}

export function decodeSessionId(id: string): string {
	if (!id || id === 'undefined' || id === 'null') {
		throw new Error('Invalid session ID: missing or empty');
	}
	const filePath = Buffer.from(id, 'base64url').toString();
	const resolved = resolve(filePath);
	const allowed = ALLOWED_SESSION_DIRS.some(dir => resolved.startsWith(dir));
	if (!allowed) {
		throw new Error('Invalid session ID: path outside sessions directory');
	}
	return resolved;
}

/** Detect whether a session file belongs to Claude Code or pi */
export function detectSessionHarness(filePath: string): 'pi' | 'claude-code' {
	return filePath.startsWith(CLAUDE_SESSIONS_DIR) ? 'claude-code' : 'pi';
}

// --- File scanning ---

interface FileInfo {
	path: string;
	mtime: number;
	size: number;
}

async function scanDir(dir: string): Promise<FileInfo[]> {
	const results: FileInfo[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(dir, entry.name);
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
		/* dir doesn't exist yet */
	}
	return results;
}

async function scanSessionFiles(): Promise<FileInfo[]> {
	const [piFiles, claudeFiles] = await Promise.all([
		scanDir(SESSIONS_DIR),
		scanDir(CLAUDE_SESSIONS_DIR),
	]);
	return [...piFiles, ...claudeFiles];
}

// --- JSONL parsing ---

export async function parseSessionMetadata(filePath: string): Promise<ParsedSessionMeta> {
	const s = await stat(filePath);
	const isClaudeSession = filePath.startsWith(CLAUDE_SESSIONS_DIR);

	if (isClaudeSession) {
		return parseClaudeSessionMetadata(filePath, s);
	}

	const text = await Bun.file(filePath).text();
	const lines = text.split('\n');

	let cwd = '';
	let name: string | null = null;
	let firstMessage = '';
	let model: string | null = null;
	let messageCount = 0;
	let totalCost = 0;

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
					totalCost += entry.message?.usage?.cost?.total ?? 0;
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
		totalCost,
		harness: 'pi' as const,
		mtime: Math.floor(s.mtimeMs),
		size: s.size,
		createdAt
	};
}

/** Parse Claude Code's JSONL session format */
async function parseClaudeSessionMetadata(filePath: string, s: import('fs').Stats): Promise<ParsedSessionMeta> {
	const text = await Bun.file(filePath).text();
	const lines = text.split('\n');

	let cwd = '';
	let firstMessage = '';
	let model: string | null = null;
	let messageCount = 0;
	let createdAt = '';

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);

			// Claude entries carry cwd on every line
			if (!cwd && entry.cwd) cwd = entry.cwd;

			// Earliest timestamp as createdAt
			if (!createdAt && entry.timestamp) createdAt = entry.timestamp;

			if (entry.type === 'user' && entry.message?.role === 'user') {
				messageCount++;
				if (!firstMessage) {
					const content = entry.message.content;
					if (typeof content === 'string') {
						firstMessage = content.slice(0, 200);
					} else if (Array.isArray(content)) {
						const text = content.find((c: any) => c.type === 'text');
						if (text?.text) firstMessage = text.text.slice(0, 200);
					}
				}
			} else if (entry.type === 'assistant') {
				messageCount++;
				// Extract model from assistant messages
				if (!model && entry.message?.model) {
					model = entry.message.model;
				}
			}
		} catch {
			/* skip malformed lines */
		}
	}

	return {
		id: encodeSessionId(filePath),
		filePath,
		cwd,
		name: null,
		firstMessage: firstMessage || '(empty session)',
		lastModified: new Date(s.mtimeMs),
		messageCount,
		model,
		totalCost: null,
		harness: 'claude-code' as const,
		mtime: Math.floor(s.mtimeMs),
		size: s.size,
		createdAt: createdAt || new Date(s.mtimeMs).toISOString()
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
	const isClaudeSession = filePath.startsWith(CLAUDE_SESSIONS_DIR);

	if (isClaudeSession) {
		// For Claude sessions, use the full parser and take the tail
		const { messages } = await getClaudeSessionMessages(filePath);
		const tail = messages.slice(-count);
		return { messages: tail, hasMore: messages.length > count };
	}

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
	total_cost: number | null;
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
		model: row.model,
		totalCost: row.total_cost ?? null,
		harness: detectSessionHarness(row.file_path),
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
					meta.createdAt,
					meta.totalCost ?? null
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
				meta.createdAt,
				meta.totalCost ?? null
			);
		} catch {
			/* skip */
		}
	}
}

export async function getSessionMessages(
	filePath: string
): Promise<{ messages: AgentMessage[]; tree: SessionTree }> {
	const isClaudeSession = filePath.startsWith(CLAUDE_SESSIONS_DIR);

	if (isClaudeSession) {
		return getClaudeSessionMessages(filePath);
	}

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

/**
 * Normalise Claude's snake_case tool input keys to pi's camelCase, so the
 * UI's per-tool pretty renderers (Bash command, Read file, Edit diff, Write)
 * fire instead of falling through to a raw JSON dump.
 *
 *   file_path  → path
 *   old_string → oldText
 *   new_string → newText
 */
function normalizeClaudeToolInput(input: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = { ...input };
	if (out.file_path !== undefined && out.path === undefined) out.path = out.file_path;
	if (out.old_string !== undefined && out.oldText === undefined) out.oldText = out.old_string;
	if (out.new_string !== undefined && out.newText === undefined) out.newText = out.new_string;
	return out;
}

/** Parse Claude Code JSONL and transpose to pi message format */
async function getClaudeSessionMessages(
	filePath: string
): Promise<{ messages: AgentMessage[]; tree: SessionTree }> {
	const text = await Bun.file(filePath).text();
	const lines = text.split('\n');
	const entries: AgentMessage[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			// Only include user and assistant messages
			if (entry.type === 'user' || entry.type === 'assistant') {
				const msg = entry.message;
				if (!msg) continue;

				const content = msg.content;

				// Normalise user content: Claude uses string, pi uses [{type:'text',text:'...'}]
				if (entry.type === 'user' && typeof content === 'string') {
					msg.content = [{ type: 'text', text: content }];
				}

				const baseEntry = {
					type: 'message' as const,
					id: entry.uuid || `claude-${entries.length}`,
					parentId: entry.parentUuid || (entries.length > 0 ? (entries[entries.length - 1] as any).id : null),
					timestamp: entry.timestamp || new Date().toISOString(),
				};

				// Tool results from Claude land as user entries with content=[{type:'tool_result',...}].
				// Surface them as toolResult bubbles (pi's render path) so the chat shows tool execution.
				if (entry.type === 'user' && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type !== 'tool_result') continue;
						const blockContent = block.content;
						let resultText = '';
						if (typeof blockContent === 'string') {
							resultText = blockContent;
						} else if (Array.isArray(blockContent)) {
							resultText = blockContent
								.filter((c: any) => c.type === 'text')
								.map((c: any) => c.text || '')
								.join('\n');
						}
						entries.push({
							...baseEntry,
							id: `${baseEntry.id}-tr-${block.tool_use_id ?? entries.length}`,
							message: {
								role: 'toolResult',
								toolCallId: block.tool_use_id,
								toolName: (block as any).tool_name || 'tool',
								isError: !!block.is_error,
								content: [{ type: 'text', text: resultText }],
							},
						} as any);
					}
					continue;
				}

				// Map assistant tool_use blocks → pi's toolCall shape so ChatBubble renders them.
				// Also normalise Claude's snake_case tool input keys to pi's camelCase
				// (file_path → path, old_string → oldText, new_string → newText) so the
				// pretty diff/file/edit renderers in ChatBubble fire instead of falling
				// through to the raw JSON dump.
				if (entry.type === 'assistant' && Array.isArray(msg.content)) {
					msg.content = msg.content.map((c: any) => {
						if (c.type === 'tool_use') {
							return {
								type: 'toolCall',
								id: c.id,
								name: c.name,
								arguments: normalizeClaudeToolInput(c.input ?? {}),
							};
						}
						return c;
					});
				}

				// Skip assistant entries with nothing renderable. Catches both the
				// "content is null/undefined" case (wrap-up entries between tool turns)
				// and the "content is array of only-already-rendered-blocks" case.
				if (entry.type === 'assistant') {
					if (!Array.isArray(msg.content) || msg.content.length === 0) continue;
					const hasText = msg.content.some((c: any) => c.type === 'text' && c.text?.trim());
					const hasThinking = msg.content.some((c: any) => c.type === 'thinking' && c.thinking?.trim());
					const hasToolCalls = msg.content.some((c: any) => c.type === 'toolCall');
					if (!hasText && !hasThinking && !hasToolCalls) continue;
				}

				entries.push({
					...baseEntry,
					message: msg,
				} as any);
			}
		} catch {
			/* skip malformed */
		}
	}

	const currentLeaf = entries.length > 0 ? (entries[entries.length - 1] as any).id : '';

	// Build a minimal tree structure compatible with SessionTree
	const nodes: Record<string, any> = {};
	const children: Record<string, string[]> = {};
	const roots: string[] = [];

	for (const e of entries) {
		const entry = e as any;
		nodes[entry.id] = entry;
		if (entry.parentId) {
			if (!children[entry.parentId]) children[entry.parentId] = [];
			children[entry.parentId].push(entry.id);
		} else {
			roots.push(entry.id);
		}
	}

	return {
		messages: entries,
		tree: {
			nodes,
			children,
			roots,
			leaves: [currentLeaf],
			currentLeaf
		}
	};
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
					meta.createdAt,
					meta.totalCost ?? null
				);
			} catch {
				/* skip */
			}
		}
	}
	console.log(`Cache warmed: ${files.length} sessions`);
}
