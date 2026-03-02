import { existsSync } from 'fs';
import { getDb } from './cache';
import { encodeSessionId } from './session-scanner';

// --- Types ---

interface ManagedSession {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	process: ReturnType<typeof Bun.spawn>;
	subscribers: Set<(event: any) => void>;
	isStreaming: boolean;
	streamingAssistantText: string;
	streamingThinkingText: string;
	buffer: string;
	pendingCommands: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	shutdownRequested: boolean;
}

interface ActiveSessionRow {
	session_id: string;
	file_path: string;
	cwd: string;
	pid: number | null;
	started_at: string;
	last_event_at: string | null;
	model: string | null;
	status: string;
}

// --- State ---

const activeSessions = new Map<string, ManagedSession>();

// --- SQLite persistence ---

const db = getDb();

const insertActiveStmt = db.query(`
	INSERT OR REPLACE INTO active_sessions
	(session_id, file_path, cwd, pid, started_at, last_event_at, model, status)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteActiveStmt = db.query('DELETE FROM active_sessions WHERE session_id = ?');
const updatePidStmt = db.query(
	'UPDATE active_sessions SET pid = ?, status = ? WHERE session_id = ?'
);
const updateEventStmt = db.query(
	'UPDATE active_sessions SET last_event_at = ? WHERE session_id = ?'
);
const getAllActiveStmt = db.query('SELECT * FROM active_sessions');

// --- Throttled heartbeat ---

const lastEventUpdate = new Map<string, number>();
function updateEventThrottled(sessionId: string) {
	const now = Date.now();
	if (now - (lastEventUpdate.get(sessionId) ?? 0) > 5000) {
		updateEventStmt.run(new Date().toISOString(), sessionId);
		lastEventUpdate.set(sessionId, now);
	}
}

// --- Command/Response correlation ---

function sendCommand(managed: ManagedSession, cmd: Record<string, any>): Promise<any> {
	const id = crypto.randomUUID();
	const promise = new Promise<any>((resolve, reject) => {
		managed.pendingCommands.set(id, { resolve, reject });
		setTimeout(() => {
			if (managed.pendingCommands.delete(id)) {
				reject(new Error(`RPC command timed out: ${cmd.type}`));
			}
		}, 30000);
	});
	const line = JSON.stringify({ ...cmd, id }) + '\n';
	const stdin = managed.process.stdin as import('bun').FileSink;
	stdin.write(line);
	return promise;
}

// --- Stdout reading ---

function readProcessOutput(managed: ManagedSession) {
	const reader = (managed.process.stdout as ReadableStream).getReader();
	const decoder = new TextDecoder();

	async function pump() {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			managed.buffer += decoder.decode(value, { stream: true });
			const lines = managed.buffer.split('\n');
			managed.buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);

					if (parsed.type === 'response' && parsed.id) {
						const pending = managed.pendingCommands.get(parsed.id);
						if (pending) {
							managed.pendingCommands.delete(parsed.id);
							if (parsed.success) {
								pending.resolve(parsed.data ?? parsed);
							} else {
								pending.reject(new Error(parsed.error ?? 'RPC command failed'));
							}
						}
						continue;
					}

					updateEventThrottled(managed.sessionId);

					if (parsed.type === 'agent_start') {
						managed.isStreaming = true;
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}
					if (parsed.type === 'agent_end') {
						managed.isStreaming = false;
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}
					if (parsed.type === 'message_update') {
						const ame = parsed.assistantMessageEvent;
						if (ame?.type === 'text_delta') {
							managed.streamingAssistantText += ame.delta;
						} else if (ame?.type === 'thinking_delta') {
							managed.streamingThinkingText += ame.delta;
						}
					}
					if (parsed.type === 'message_start' && parsed.message?.role === 'assistant') {
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}

					for (const cb of managed.subscribers) cb(parsed);
				} catch {
					/* skip malformed lines */
				}
			}
		}
	}
	pump().catch(err => console.error(`Stream read error for ${managed.sessionId}:`, err));
}

// --- Wire process exit handler ---

function wireExitHandler(managed: ManagedSession) {
	managed.process.exited.then(() => {
		activeSessions.delete(managed.sessionId);
		lastEventUpdate.delete(managed.sessionId);
		if (!managed.shutdownRequested) {
			deleteActiveStmt.run(managed.sessionId);
		}
		for (const [, pending] of managed.pendingCommands) {
			pending.reject(new Error('RPC process exited'));
		}
		managed.pendingCommands.clear();
		for (const cb of managed.subscribers) {
			cb({ type: 'session_ended' });
		}
	});
}

// --- Public API ---

export async function resumeSession(
	sessionId: string,
	filePath: string,
	cwd: string
): Promise<void> {
	insertActiveStmt.run(sessionId, filePath, cwd, null, new Date().toISOString(), null, null, 'starting');

	const piBin = process.env.PI_BIN || 'pi';
	const proc = Bun.spawn([piBin, '--mode', 'rpc', '--session', filePath], {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe'
	});

	updatePidStmt.run(proc.pid, 'running', sessionId);

	const managed: ManagedSession = {
		sessionId,
		sessionPath: filePath,
		cwd,
		process: proc,
		subscribers: new Set(),
		isStreaming: false,
		streamingAssistantText: '',
		streamingThinkingText: '',
		buffer: '',
		pendingCommands: new Map(),
		shutdownRequested: false
	};
	activeSessions.set(sessionId, managed);

	readProcessOutput(managed);
	wireExitHandler(managed);
}

export async function createSession(cwd: string, model?: string): Promise<string> {
	const piBin = process.env.PI_BIN || 'pi';
	const args = [piBin, '--mode', 'rpc'];
	if (model) args.push('--model', model);

	const proc = Bun.spawn(args, {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const managed: ManagedSession = {
		sessionId: '',
		sessionPath: '',
		cwd,
		process: proc,
		subscribers: new Set(),
		isStreaming: false,
		streamingAssistantText: '',
		streamingThinkingText: '',
		buffer: '',
		pendingCommands: new Map(),
		shutdownRequested: false
	};

	readProcessOutput(managed);
	wireExitHandler(managed);

	const state = await sendCommand(managed, { type: 'get_state' });
	const filePath = state.sessionFile;
	const sessionId = encodeSessionId(filePath);

	managed.sessionId = sessionId;
	managed.sessionPath = filePath;
	activeSessions.set(sessionId, managed);

	insertActiveStmt.run(
		sessionId,
		filePath,
		cwd,
		proc.pid,
		new Date().toISOString(),
		null,
		state.model?.id ?? null,
		'running'
	);

	return sessionId;
}

export async function sendMessage(
	sessionId: string,
	message: string,
	behavior?: 'steer' | 'followUp'
): Promise<any> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');

	if (behavior === 'steer') {
		return sendCommand(managed, { type: 'steer', message });
	} else if (behavior === 'followUp') {
		return sendCommand(managed, { type: 'follow_up', message });
	} else {
		return sendCommand(managed, { type: 'prompt', message });
	}
}

export async function getState(sessionId: string): Promise<any> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');
	return sendCommand(managed, { type: 'get_state' });
}

export async function abortSession(sessionId: string): Promise<void> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');
	await sendCommand(managed, { type: 'abort' });
}

export async function stopSession(sessionId: string): Promise<void> {
	const managed = activeSessions.get(sessionId);
	if (managed) {
		managed.process.kill();
		await managed.process.exited;
	} else {
		deleteActiveStmt.run(sessionId);
	}
}

export async function sendExtensionUIResponse(
	sessionId: string,
	response: Record<string, any>
): Promise<void> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');
	const line = JSON.stringify(response) + '\n';
	const stdin = managed.process.stdin as import('bun').FileSink;
	stdin.write(line);
}

export function subscribe(sessionId: string, callback: (event: any) => void): () => void {
	const managed = activeSessions.get(sessionId);
	if (!managed) {
		return () => {};
	}
	managed.subscribers.add(callback);

	// Send sync event so late subscribers can catch up with current streaming state
	callback({
		type: 'stream_sync',
		isStreaming: managed.isStreaming,
		assistantText: managed.isStreaming ? managed.streamingAssistantText : '',
		thinkingText: managed.isStreaming ? managed.streamingThinkingText : ''
	});

	return () => managed.subscribers.delete(callback);
}

export function isActive(sessionId: string): boolean {
	return activeSessions.has(sessionId);
}

export function isStreaming(sessionId: string): boolean {
	const managed = activeSessions.get(sessionId);
	return managed?.isStreaming ?? false;
}

export function getActiveSessionIds(): Set<string> {
	return new Set(activeSessions.keys());
}

export function getActiveSession(sessionId: string): { cwd: string; model: string | null } | null {
	const managed = activeSessions.get(sessionId);
	if (!managed) return null;
	return { cwd: managed.cwd, model: null };
}

export async function getSessionStats(sessionId: string): Promise<any> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');
	return sendCommand(managed, { type: 'get_session_stats' });
}

// --- Crash recovery ---

export async function recoverActiveSessions() {
	const rows = getAllActiveStmt.all() as ActiveSessionRow[];

	let recovered = 0;
	for (const row of rows) {
		const isAlive = row.pid ? isProcessAlive(row.pid) : false;

		if (isAlive) {
			try {
				process.kill(row.pid!, 'SIGTERM');
			} catch {
				/* ignore */
			}
			// Wait for process to exit before re-spawning
			const deadline = Date.now() + 3000;
			while (isProcessAlive(row.pid!) && Date.now() < deadline) {
				await Bun.sleep(100);
			}
			if (isProcessAlive(row.pid!)) {
				console.warn(`Process ${row.pid} did not exit in time, skipping recovery of ${row.session_id}`);
				deleteActiveStmt.run(row.session_id);
				continue;
			}
		}

		if (!existsSync(row.file_path)) {
			deleteActiveStmt.run(row.session_id);
			continue;
		}

		console.log(`Recovering session: ${row.session_id} (${row.cwd})`);
		try {
			await resumeSession(row.session_id, row.file_path, row.cwd);
			recovered++;
		} catch (err) {
			console.error(`Failed to recover ${row.session_id}:`, err);
			deleteActiveStmt.run(row.session_id);
		}
	}

	if (rows.length > 0) {
		console.log(`Recovered ${recovered}/${rows.length} active sessions`);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// --- Graceful shutdown ---

async function handleShutdown() {
	console.log('Shutting down — killing RPC processes...');
	for (const [, managed] of activeSessions) {
		managed.shutdownRequested = true;
		managed.process.kill();
	}
	await Promise.allSettled([...activeSessions.values()].map(m => m.process.exited));
	process.exit(0);
}

process.on('SIGTERM', () => { handleShutdown(); });
process.on('SIGINT', () => { handleShutdown(); });
