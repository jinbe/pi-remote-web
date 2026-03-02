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
	lastAgentStartTime: number | null;
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

// --- Constants ---

const MAX_STREAMING_TEXT = 100 * 1024; // 100KB cap for accumulated streaming text
const COMMAND_TIMEOUT_MS = 30_000;

// --- State ---

const activeSessions = new Map<string, ManagedSession>();
const resumingSessionIds = new Set<string>();

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

function writeToStdin(managed: ManagedSession, line: string): void {
	try {
		const stdin = managed.process.stdin as import('bun').FileSink;
		stdin.write(line);
	} catch (err) {
		throw new Error(`Failed to write to stdin: ${err}`);
	}
}

function sendCommand(managed: ManagedSession, cmd: Record<string, any>): Promise<any> {
	const id = crypto.randomUUID();
	const line = JSON.stringify({ ...cmd, id }) + '\n';

	// Write first — if it fails, don't create a pending command
	try {
		writeToStdin(managed, line);
	} catch (err) {
		return Promise.reject(err);
	}

	const promise = new Promise<any>((resolve, reject) => {
		managed.pendingCommands.set(id, { resolve, reject });
		setTimeout(() => {
			if (managed.pendingCommands.delete(id)) {
				console.warn(`RPC command timed out: ${cmd.type} (session: ${managed.sessionId})`);
				reject(new Error(`RPC command timed out: ${cmd.type}`));
			}
		}, COMMAND_TIMEOUT_MS);
	});

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
						managed.lastAgentStartTime = Date.now();
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}
					if (parsed.type === 'agent_end') {
						managed.isStreaming = false;
						managed.lastAgentStartTime = null;
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}
					if (parsed.type === 'message_update') {
						const ame = parsed.assistantMessageEvent;
						if (ame?.type === 'text_delta') {
							managed.streamingAssistantText += ame.delta;
							// Cap accumulated text to prevent unbounded growth
							if (managed.streamingAssistantText.length > MAX_STREAMING_TEXT) {
								managed.streamingAssistantText = managed.streamingAssistantText.slice(-MAX_STREAMING_TEXT);
							}
						} else if (ame?.type === 'thinking_delta') {
							managed.streamingThinkingText += ame.delta;
							if (managed.streamingThinkingText.length > MAX_STREAMING_TEXT) {
								managed.streamingThinkingText = managed.streamingThinkingText.slice(-MAX_STREAMING_TEXT);
							}
						}
					}
					if (parsed.type === 'message_start' && parsed.message?.role === 'assistant') {
						managed.streamingAssistantText = '';
						managed.streamingThinkingText = '';
					}

					// Copy subscriber set to avoid issues if a callback modifies subscribers
					for (const cb of [...managed.subscribers]) cb(parsed);
				} catch {
					/* skip malformed lines */
				}
			}
		}
	}
	pump().catch(err => console.error(`Stream read error for ${managed.sessionId}:`, err));
}

// --- Stderr consumption (prevent pipe buffer deadlock) ---

function consumeStderr(managed: ManagedSession) {
	const stderr = managed.process.stderr;
	if (!stderr) return;
	new Response(stderr as ReadableStream).text().then(text => {
		if (text.trim()) {
			console.error(`[${managed.sessionId}] stderr: ${text.slice(0, 2000)}`);
		}
	}).catch(() => { /* process exited */ });
}

// --- Wire process exit handler ---

function wireExitHandler(managed: ManagedSession) {
	managed.process.exited.then(() => {
		activeSessions.delete(managed.sessionId);
		lastEventUpdate.delete(managed.sessionId);
		resumingSessionIds.delete(managed.sessionId);
		if (!managed.shutdownRequested) {
			deleteActiveStmt.run(managed.sessionId);
		}
		for (const [, pending] of managed.pendingCommands) {
			pending.reject(new Error('RPC process exited'));
		}
		managed.pendingCommands.clear();
		// Copy subscriber set — callbacks may call unsubscribe
		for (const cb of [...managed.subscribers]) {
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
	// Guard against concurrent resume of the same session
	if (activeSessions.has(sessionId) || resumingSessionIds.has(sessionId)) {
		return;
	}
	resumingSessionIds.add(sessionId);

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
		shutdownRequested: false,
		lastAgentStartTime: null
	};
	activeSessions.set(sessionId, managed);

	readProcessOutput(managed);
	consumeStderr(managed);
	wireExitHandler(managed);

	// Sync initial streaming state from pi in case the agent is already running
	try {
		const state = await sendCommand(managed, { type: 'get_state' });
		if (state.isStreaming) {
			managed.isStreaming = true;
			managed.lastAgentStartTime = Date.now();
		}
	} catch {
		/* ignore — process may not be ready yet */
	} finally {
		resumingSessionIds.delete(sessionId);
	}
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
		shutdownRequested: false,
		lastAgentStartTime: null
	};

	readProcessOutput(managed);
	consumeStderr(managed);
	wireExitHandler(managed);

	let state: any;
	try {
		state = await sendCommand(managed, { type: 'get_state' });
	} catch (err) {
		// Kill orphaned process on startup failure
		managed.process.kill();
		throw err;
	}

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
		// When agent is streaming and no explicit behavior, auto-queue as follow-up
		// to avoid the RPC error for prompt-during-streaming
		if (managed.isStreaming) {
			return sendCommand(managed, { type: 'follow_up', message });
		}
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
	writeToStdin(managed, line);
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

export function getStreamingState(sessionId: string): {
	isStreaming: boolean;
	lastAgentStartTime: number | null;
} {
	const managed = activeSessions.get(sessionId);
	return {
		isStreaming: managed?.isStreaming ?? false,
		lastAgentStartTime: managed?.lastAgentStartTime ?? null
	};
}

export function resetStreaming(sessionId: string): void {
	const managed = activeSessions.get(sessionId);
	if (managed) {
		managed.isStreaming = false;
		managed.lastAgentStartTime = null;
		managed.streamingAssistantText = '';
		managed.streamingThinkingText = '';
	}
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

export async function getCommands(sessionId: string): Promise<any> {
	const managed = activeSessions.get(sessionId);
	if (!managed) throw new Error('Session not active');
	return sendCommand(managed, { type: 'get_commands' });
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
