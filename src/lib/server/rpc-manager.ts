import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';
import { getDb, insertSessionEvent } from './cache';
import { encodeSessionId } from './session-scanner';
import { log } from './logger';
import type { Socket } from 'bun';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Types ---

interface ManagedSession {
	sessionId: string;
	sessionPath: string;
	cwd: string;
	relayPid: number;
	socketPath: string;
	socket: Socket<undefined> | null;
	subscribers: Set<(event: any) => void>;
	isStreaming: boolean;
	streamingAssistantText: string;
	streamingThinkingText: string;
	buffer: string;
	pendingCommands: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>;
	lastAgentStartTime: number | null;
	autoStopTimer: ReturnType<typeof setTimeout> | null;
	// Write queue for handling socket backpressure on large payloads
	writeQueue: Uint8Array[];
	writing: boolean;
	// Cached commands — fetched once after connect, served instantly thereafter
	cachedCommands: any[] | null;
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
	socket_path: string | null;
}

// --- Constants ---

const MAX_STREAMING_TEXT = 100 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMANDS_QUERY_TIMEOUT_MS = 5_000; // shorter timeout for metadata queries like get_commands
const STATE_CHECK_TIMEOUT_MS = 5_000; // shorter timeout for pre-send state checks
// prompt responds immediately in pi's RPC mode (fire-and-forget), so use a
// shorter timeout. If the command doesn't reach pi within 10s something is wrong.
const PROMPT_TIMEOUT_MS = 10_000;
// steer/follow_up await session methods and may block while the agent is busy,
// so they need a longer timeout.
const STEER_TIMEOUT_MS = 60_000;

const RELAY_SCRIPT = join(__dirname, 'pi-relay.ts');
const SOCKET_DIR = join(tmpdir(), 'pi-remote-web');

// --- State (stored on globalThis to survive Vite HMR module re-evaluation) ---

const g = globalThis as any;
if (!g.__piActiveSessions) g.__piActiveSessions = new Map<string, ManagedSession>();
if (!g.__piResumingSessionIds) g.__piResumingSessionIds = new Set<string>();
if (!g.__piLastEventUpdate) g.__piLastEventUpdate = new Map<string, number>();

const activeSessions: Map<string, ManagedSession> = g.__piActiveSessions;
const resumingSessionIds: Set<string> = g.__piResumingSessionIds;

// --- SQLite persistence ---

const db = getDb();

const insertActiveStmt = db.query(`
	INSERT OR REPLACE INTO active_sessions
	(session_id, file_path, cwd, pid, started_at, last_event_at, model, status, socket_path)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteActiveStmt = db.query('DELETE FROM active_sessions WHERE session_id = ?');
const updatePidStmt = db.query(
	'UPDATE active_sessions SET pid = ?, status = ? WHERE session_id = ?'
);
const updateEventStmt = db.query(
	'UPDATE active_sessions SET last_event_at = ? WHERE session_id = ?'
);
const getAllActiveStmt = db.query('SELECT * FROM active_sessions');

// --- Ensure socket directory ---

import { mkdirSync } from 'fs';
try { mkdirSync(SOCKET_DIR, { recursive: true }); } catch {}

// --- HMR socket recovery ---
// When Vite HMR reloads this module, the globalThis map survives but the
// Bun socket objects in ManagedSession become stale (closures from the old
// module are garbage collected). Reconnect any sessions with dead sockets.

if (activeSessions.size > 0) {
	log.info('hmr', `module reloaded — checking ${activeSessions.size} active session(s) for stale sockets`);
	(async () => {
		for (const [sessionId, managed] of activeSessions) {
			// Test the socket by trying a quick get_state
			try {
				if (!managed.socket) throw new Error('no socket');
				await sendCommand(managed, { type: 'get_state' }, 2_000);
			} catch {
				log.info('hmr', `reconnecting stale socket for session ${sessionId}`);
				try {
					managed.socket = null;
					managed.buffer = '';
					managed.pendingCommands = new Map();
					managed.writeQueue = [];
					managed.writing = false;
					managed.cachedCommands = null;
					await connectToRelay(managed);
					prefetchCommands(managed);
					log.info('hmr', `reconnected session ${sessionId}`);
				} catch (err) {
					log.error('hmr', `failed to reconnect session ${sessionId}: ${err}`);
				}
			}
		}
	})();
}

// --- Throttled heartbeat ---

const lastEventUpdate: Map<string, number> = g.__piLastEventUpdate;
function updateEventThrottled(sessionId: string) {
	const now = Date.now();
	if (now - (lastEventUpdate.get(sessionId) ?? 0) > 5000) {
		updateEventStmt.run(new Date().toISOString(), sessionId);
		lastEventUpdate.set(sessionId, now);
	}
}

// --- Socket path helpers ---

function socketPathFor(sessionId: string): string {
	// Use a hash to avoid path length issues
	const hash = Bun.hash(sessionId).toString(36);
	return join(SOCKET_DIR, `pi-${hash}.sock`);
}

function pidPathFor(socketPath: string): string {
	return socketPath.replace(/\.sock$/, '.pid');
}

// --- Write to relay socket ---

/**
 * Drain the write queue, handling partial writes from Bun's socket.
 * Bun Socket.write() returns the number of bytes actually written and may
 * return less than the full buffer (8KB typical limit). When that happens
 * the remaining data must be re-queued and sent when the `drain` callback fires.
 */
function drainWriteQueue(managed: ManagedSession): void {
	if (!managed.socket || managed.writeQueue.length === 0) {
		managed.writing = false;
		return;
	}
	managed.writing = true;

	while (managed.writeQueue.length > 0) {
		const chunk = managed.writeQueue[0];
		const written = managed.socket.write(chunk);
		if (written === 0) {
			// Socket buffer full — wait for drain callback
			return;
		}
		if (written < chunk.length) {
			// Partial write — re-queue the remainder and wait for drain
			managed.writeQueue[0] = chunk.slice(written);
			return;
		}
		// Full chunk written — remove from queue and continue
		managed.writeQueue.shift();
	}
	managed.writing = false;
}

function writeToSocket(managed: ManagedSession, data: string): void {
	if (!managed.socket) throw new Error('Not connected to relay');
	const encoded = new TextEncoder().encode(data);
	managed.writeQueue.push(encoded);
	if (!managed.writing) {
		drainWriteQueue(managed);
	}
}

// --- Command/Response correlation ---

function sendCommand(managed: ManagedSession, cmd: Record<string, any>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<any> {
	const id = crypto.randomUUID();
	const line = JSON.stringify({ ...cmd, id }) + '\n';

	try {
		writeToSocket(managed, line);
	} catch (err) {
		return Promise.reject(err);
	}

	const promise = new Promise<any>((resolve, reject) => {
		managed.pendingCommands.set(id, { resolve, reject });
		setTimeout(() => {
			if (managed.pendingCommands.delete(id)) {
				log.warn('rpc', `command timed out: ${cmd.type} id=${id} session=${managed.sessionId} pendingCommands remaining: ${managed.pendingCommands.size}`);
				reject(new Error(`RPC command timed out: ${cmd.type}`));
			}
		}, timeoutMs);
	});

	return promise;
}

// --- Process incoming data from relay socket ---

function processData(managed: ManagedSession, raw: Buffer | Uint8Array) {
	managed.buffer += new TextDecoder().decode(raw);
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
						log.error('rpc', `command failed: ${parsed.command} error=${parsed.error}`);
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
				insertSessionEvent(managed.sessionId, 'agent_start');
				if (managed.autoStopTimer) {
					clearTimeout(managed.autoStopTimer);
					managed.autoStopTimer = null;
				}
			}
			if (parsed.type === 'agent_end') {
				// Capture accumulated text before clearing — subscribers may need it
				// (e.g. job-poller extracting PR_URL / VERDICT from the final message)
				parsed._lastAssistantText = managed.streamingAssistantText;
				managed.isStreaming = false;
				managed.lastAgentStartTime = null;
				managed.streamingAssistantText = '';
				managed.streamingThinkingText = '';
				insertSessionEvent(managed.sessionId, 'agent_end');
			}
			if (parsed.type === 'session_ended') {
				handleSessionEnded(managed);
				return; // Stop processing — session is done
			}
			if (parsed.type === 'auto_compaction_start') {
				insertSessionEvent(managed.sessionId, 'compaction_start');
			}
			if (parsed.type === 'auto_compaction_end') {
				insertSessionEvent(managed.sessionId, 'compaction_end');
			}
			if (parsed.type === 'message_update') {
				const ame = parsed.assistantMessageEvent;
				if (ame?.type === 'text_delta') {
					managed.streamingAssistantText += ame.delta;
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

			for (const cb of [...managed.subscribers]) cb(parsed);
		} catch {
			/* skip malformed lines */
		}
	}
}

// --- Handle session ended (relay reported pi exited) ---

function handleSessionEnded(managed: ManagedSession) {
	insertSessionEvent(managed.sessionId, 'session_ended');
	if (managed.autoStopTimer) {
		clearTimeout(managed.autoStopTimer);
		managed.autoStopTimer = null;
	}
	activeSessions.delete(managed.sessionId);
	lastEventUpdate.delete(managed.sessionId);
	resumingSessionIds.delete(managed.sessionId);
	deleteActiveStmt.run(managed.sessionId);

	for (const [, pending] of managed.pendingCommands) {
		pending.reject(new Error('Session ended'));
	}
	managed.pendingCommands.clear();

	for (const cb of [...managed.subscribers]) {
		cb({ type: 'session_ended' });
	}

	// Close our socket connection (relay will clean itself up)
	try { managed.socket?.end(); } catch {}
	managed.socket = null;
}

// --- Spawn relay daemon ---

async function spawnRelay(
	socketPath: string,
	cwd: string,
	piArgs: string[]
): Promise<number> {
	log.info('relay', `spawning: ${RELAY_SCRIPT} ${socketPath} ${cwd} ${piArgs.join(' ')}`);

	// Spawn relay as a detached process that survives our exit.
	// Use stdin/stdout/stderr: 'ignore' so no pipe ties us to the child.
	// The relay writes a PID file and creates the socket — we poll for those.
	const proc = Bun.spawn(['bun', 'run', RELAY_SCRIPT, socketPath, cwd, ...piArgs], {
		cwd,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		env: { ...process.env },
	});
	proc.unref();

	// Wait for PID file + socket to appear (relay writes PID file first, then creates socket)
	const pidPath = pidPathFor(socketPath);
	const deadline = Date.now() + 10_000;

	while (Date.now() < deadline) {
		await Bun.sleep(50);

		// Check if spawned process died immediately
		if (proc.exitCode !== null && proc.exitCode !== 0) {
			throw new Error(`Relay exited immediately with code ${proc.exitCode}`);
		}

		if (existsSync(pidPath) && existsSync(socketPath)) {
			const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
			if (pid > 0 && isProcessAlive(pid)) {
				log.info('relay', `ready: pid ${pid}`);
				return pid;
			}
		}
	}

	throw new Error('Relay failed to start within 10s');
}

// --- Connect to relay socket ---

async function connectToRelay(managed: ManagedSession): Promise<void> {
	// Retry connection — the socket may not be ready immediately after relay spawn
	let lastErr: Error | null = null;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const socket = await Bun.connect({
				unix: managed.socketPath,
				socket: {
					data(_socket, data) {
						processData(managed, data);
					},
					drain() {
						// Socket is ready for more data — continue draining the write queue
						drainWriteQueue(managed);
					},
					open() {},
					close() {
						if (activeSessions.has(managed.sessionId) && managed.socket) {
							managed.socket = null;
							handleSessionEnded(managed);
						}
					},
					error(_socket, err) {
						log.error('socket', `error for ${managed.sessionId}: ${err.message}`);
					},
				},
			});
			managed.socket = socket;
			return;
		} catch (err) {
			lastErr = err as Error;
			await Bun.sleep(100);
		}
	}
	throw new Error(`Failed to connect to relay socket ${managed.socketPath}: ${lastErr?.message}`);
}

// --- Public API ---

export async function resumeSession(
	sessionId: string,
	filePath: string,
	cwd: string
): Promise<void> {
	if (activeSessions.has(sessionId) || resumingSessionIds.has(sessionId)) {
		return;
	}
	resumingSessionIds.add(sessionId);

	const socketPath = socketPathFor(sessionId);

	try {
		// Check if a relay is already running for this session
		let relayPid = getRelayPid(socketPath);

		if (!relayPid) {
			// Spawn a new relay
			insertActiveStmt.run(sessionId, filePath, cwd, null, new Date().toISOString(), null, null, 'starting', socketPath);
			relayPid = await spawnRelay(socketPath, cwd, ['--session', filePath]);
		}

		const managed: ManagedSession = {
			sessionId,
			sessionPath: filePath,
			cwd,
			relayPid,
			socketPath,
			socket: null,
			subscribers: new Set(),
			isStreaming: false,
			streamingAssistantText: '',
			streamingThinkingText: '',
			buffer: '',
			pendingCommands: new Map(),
			lastAgentStartTime: null,
			autoStopTimer: null,
			writeQueue: [],
			writing: false,
			cachedCommands: null,
		};

		await connectToRelay(managed);
		activeSessions.set(sessionId, managed);
		updatePidStmt.run(relayPid, 'running', sessionId);

		// Record session resumed event
		insertSessionEvent(sessionId, 'session_resumed');

		// Sync streaming state
		try {
			const state = await sendCommand(managed, { type: 'get_state' });
			if (state.isStreaming) {
				managed.isStreaming = true;
				managed.lastAgentStartTime = Date.now();
			}
		} catch {
			/* process may not be ready yet */
		}

		// Pre-fetch commands in background so they're ready for slash completion
		prefetchCommands(managed);
	} catch (err) {
		deleteActiveStmt.run(sessionId);
		throw err;
	} finally {
		resumingSessionIds.delete(sessionId);
	}
}

export async function createSession(cwd: string, model?: string): Promise<string> {
	const tempId = crypto.randomUUID();
	const socketPath = socketPathFor(tempId);

	const piArgs: string[] = [];
	if (model) piArgs.push('--model', model);

	const relayPid = await spawnRelay(socketPath, cwd, piArgs);

	const managed: ManagedSession = {
		sessionId: '',
		sessionPath: '',
		cwd,
		relayPid,
		socketPath,
		socket: null,
		subscribers: new Set(),
		isStreaming: false,
		streamingAssistantText: '',
		streamingThinkingText: '',
		buffer: '',
		pendingCommands: new Map(),
		lastAgentStartTime: null,
		autoStopTimer: null,
		writeQueue: [],
		writing: false,
			cachedCommands: null,
	};

	await connectToRelay(managed);

	let state: any;
	try {
		state = await sendCommand(managed, { type: 'get_state' });
	} catch (err) {
		// Kill relay on failure
		killRelay(relayPid, socketPath);
		throw err;
	}

	const filePath = state.sessionFile;
	const sessionId = encodeSessionId(filePath);

	// Re-map to the real socket path based on actual session ID
	const realSocketPath = socketPathFor(sessionId);
	if (realSocketPath !== socketPath) {
		// Move socket — reconnect is needed. For simplicity, just keep the temp socket.
		// The relay doesn't care about the socket path after startup.
	}

	managed.sessionId = sessionId;
	managed.sessionPath = filePath;
	managed.socketPath = socketPath; // Keep the original socket path
	activeSessions.set(sessionId, managed);

	insertActiveStmt.run(
		sessionId,
		filePath,
		cwd,
		relayPid,
		new Date().toISOString(),
		null,
		state.model?.id ?? null,
		'running',
		socketPath
	);

	// Record session created event
	insertSessionEvent(sessionId, 'session_created');

	// Pre-fetch commands in background so they're ready for slash completion
	prefetchCommands(managed);

	return sessionId;
}

export async function sendMessage(
	sessionId: string,
	message: string,
	behavior?: 'steer' | 'followUp',
	images?: Array<{ type: 'image'; data: string; mimeType: string }>
): Promise<any> {
	const managed = activeSessions.get(sessionId);
	if (!managed) {
		throw new Error('Session not active');
	}

	// If we think we're streaming, verify with pi's actual state
	// to handle missed agent_end events. Use a short timeout so this
	// pre-check doesn't block the user for 30s when pi is unresponsive.
	let actuallyStreaming = managed.isStreaming;
	if (actuallyStreaming && !behavior) {
		try {
			const state = await sendCommand(managed, { type: 'get_state' }, STATE_CHECK_TIMEOUT_MS);
			actuallyStreaming = state.isStreaming || (state.pendingMessageCount ?? 0) > 0;
			if (!actuallyStreaming && managed.isStreaming) {
				log.warn('sendMessage', `correcting streaming state — pi says not streaming, resetting`);
				managed.isStreaming = false;
				managed.lastAgentStartTime = null;
				managed.streamingAssistantText = '';
				managed.streamingThinkingText = '';
			}
		} catch {
			// If get_state fails/times out, fall back to local state.
			// Don't block the prompt send — the user is waiting.
			log.warn('sendMessage', `get_state pre-check failed, falling back to local state (isStreaming=${managed.isStreaming})`);
		}
	}

	const imagePayload = images && images.length > 0 ? images : undefined;

	if (behavior === 'steer') {
		return sendCommand(managed, { type: 'steer', message, ...(imagePayload && { images: imagePayload }) }, STEER_TIMEOUT_MS);
	} else if (behavior === 'followUp') {
		return sendCommand(managed, { type: 'follow_up', message, ...(imagePayload && { images: imagePayload }) }, STEER_TIMEOUT_MS);
	} else {
		if (actuallyStreaming) {
			return sendCommand(managed, { type: 'follow_up', message, ...(imagePayload && { images: imagePayload }) }, STEER_TIMEOUT_MS);
		}
		// prompt responds immediately in pi's RPC mode (fire-and-forget)
		return sendCommand(managed, { type: 'prompt', message, ...(imagePayload && { images: imagePayload }) }, PROMPT_TIMEOUT_MS);
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
		// Record event before stopping
		insertSessionEvent(sessionId, 'session_stopped');
		// Send SIGUSR1 to relay — it will kill pi, notify us via session_ended, then exit
		try {
			process.kill(managed.relayPid, 'SIGUSR1');
		} catch {
			// Relay already dead — clean up manually
			handleSessionEnded(managed);
		}
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
	writeToSocket(managed, JSON.stringify(response) + '\n');
}

export function subscribe(sessionId: string, callback: (event: any) => void): () => void {
	const managed = activeSessions.get(sessionId);
	if (!managed) {
		return () => {};
	}
	managed.subscribers.add(callback);

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
	if (!managed) {
		log.warn('commands', `getCommands called for inactive session ${sessionId}`);
		throw new Error('Session not active');
	}

	// Return cached commands instantly — commands don't change during a session
	if (managed.cachedCommands) {
		log.info('commands', `getCommands cache hit for ${sessionId}: ${managed.cachedCommands.length} commands`);
		return { commands: managed.cachedCommands };
	}

	// If not cached yet, trigger a background fetch and return empty
	// The prefetch will populate the cache for the next request
	log.info('commands', `getCommands cache miss for ${sessionId} — triggering prefetch`);
	prefetchCommands(managed);
	return { commands: [] };
}

/**
 * Pre-fetch and cache commands for a session in the background.
 * Called after session connect when the agent is idle.
 */
function prefetchCommands(managed: ManagedSession): void {
	if (managed.cachedCommands) {
		log.info('commands', `prefetch skipped for ${managed.sessionId} — already cached (${managed.cachedCommands.length} commands)`);
		return;
	}
	if (managed.isStreaming) {
		log.info('commands', `prefetch skipped for ${managed.sessionId} — session is streaming`);
		return;
	}
	log.info('commands', `prefetching commands for ${managed.sessionId}...`);
	sendCommand(managed, { type: 'get_commands' }, COMMANDS_QUERY_TIMEOUT_MS)
		.then((result: any) => {
			const commands = Array.isArray(result) ? result : (result?.commands ?? []);
			log.info('commands', `prefetch result for ${managed.sessionId}: ${commands.length} commands`);
			if (commands.length > 0) {
				managed.cachedCommands = commands;
			}
		})
		.catch((err: any) => {
			log.warn('commands', `prefetch failed for ${managed.sessionId}: ${err.message ?? err}`);
		});
}

// --- Relay lifecycle helpers ---

function getRelayPid(socketPath: string): number | null {
	const pidPath = pidPathFor(socketPath);
	if (!existsSync(pidPath)) return null;
	try {
		const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
		if (pid > 0 && isProcessAlive(pid) && existsSync(socketPath)) {
			return pid;
		}
	} catch {}
	return null;
}

function killRelay(pid: number, socketPath: string) {
	try { process.kill(pid, 'SIGTERM'); } catch {}
	try { unlinkSync(socketPath); } catch {}
	try { unlinkSync(pidPathFor(socketPath)); } catch {}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// --- Crash recovery ---

export async function recoverActiveSessions() {
	const rows = getAllActiveStmt.all() as ActiveSessionRow[];

	let recovered = 0;
	let reconnected = 0;

	for (const row of rows) {
		if (!existsSync(row.file_path)) {
			deleteActiveStmt.run(row.session_id);
			continue;
		}

		// If already connected in-memory, skip — avoids duplicate connections on HMR
		const existing = activeSessions.get(row.session_id);
		if (existing?.socket) {
			log.info('recovery', `already connected: ${row.session_id} — skipping`);
			continue;
		}

		// Close any stale socket from a previous in-memory entry
		if (existing) {
			try { existing.socket?.end(); } catch {}
		}

		const socketPath = row.socket_path || socketPathFor(row.session_id);
		const relayPid = getRelayPid(socketPath);

		if (relayPid) {
			// Relay is still alive! Just reconnect.
			log.info('recovery', `reconnecting to live relay: ${row.session_id} (pid ${relayPid})`);
			try {
				const managed: ManagedSession = {
					sessionId: row.session_id,
					sessionPath: row.file_path,
					cwd: row.cwd,
					relayPid,
					socketPath,
					socket: null,
					subscribers: new Set(),
					isStreaming: false,
					streamingAssistantText: '',
					streamingThinkingText: '',
					buffer: '',
					pendingCommands: new Map(),
					lastAgentStartTime: null,
					autoStopTimer: null,
					writeQueue: [],
					writing: false,
			cachedCommands: null,
				};

				await connectToRelay(managed);
				activeSessions.set(row.session_id, managed);
				updatePidStmt.run(relayPid, 'running', row.session_id);

				// Sync streaming state — the agent may still be running
				try {
					const state = await sendCommand(managed, { type: 'get_state' });
					if (state.isStreaming) {
						managed.isStreaming = true;
						managed.lastAgentStartTime = Date.now();
					}
				} catch {}

				prefetchCommands(managed);
				reconnected++;
				continue;
			} catch (err) {
				log.error('recovery', `failed to reconnect to relay ${row.session_id}: ${err}`);
				killRelay(relayPid, socketPath);
			}
		} else {
			// Relay is dead — kill any stale pi process and respawn
			if (row.pid && isProcessAlive(row.pid)) {
				try { process.kill(row.pid, 'SIGTERM'); } catch {}
				const deadline = Date.now() + 3000;
				while (isProcessAlive(row.pid) && Date.now() < deadline) {
					await Bun.sleep(100);
				}
			}
		}

		log.info('recovery', `recovering session: ${row.session_id} (${row.cwd})`);
		try {
			await resumeSession(row.session_id, row.file_path, row.cwd);
			recovered++;
		} catch (err) {
			log.error('recovery', `failed to recover ${row.session_id}: ${err}`);
			deleteActiveStmt.run(row.session_id);
		}
	}

	if (rows.length > 0) {
		log.info('recovery', `${reconnected} reconnected, ${recovered} respawned (of ${rows.length} total)`);
	}
}

// --- Graceful shutdown ---

async function handleShutdown() {
	log.info('shutdown', 'disconnecting from relays (agents stay alive)...');

	// Disconnect from all relays but DON'T kill them
	for (const [, managed] of activeSessions) {
		if (managed.autoStopTimer) {
			clearTimeout(managed.autoStopTimer);
			managed.autoStopTimer = null;
		}
		try { managed.socket?.end(); } catch {}
		managed.socket = null;
		// Note: we do NOT delete from active_sessions DB — we want to reconnect on restart
	}
	activeSessions.clear();
	process.exit(0);
}

process.on('SIGTERM', () => { handleShutdown(); });
process.on('SIGINT', () => { handleShutdown(); });
