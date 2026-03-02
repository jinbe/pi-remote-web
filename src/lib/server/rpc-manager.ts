import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';
import { getDb } from './cache';
import { encodeSessionId } from './session-scanner';
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
const AUTO_STOP_DELAY_MS = 1500;
const RELAY_SCRIPT = join(__dirname, 'pi-relay.ts');
const SOCKET_DIR = join(tmpdir(), 'pi-remote-web');

// --- State ---

const activeSessions = new Map<string, ManagedSession>();
const resumingSessionIds = new Set<string>();

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

// --- Throttled heartbeat ---

const lastEventUpdate = new Map<string, number>();
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

function writeToSocket(managed: ManagedSession, data: string): void {
	if (!managed.socket) throw new Error('Not connected to relay');
	try {
		managed.socket.write(data);
	} catch (err) {
		throw new Error(`Failed to write to relay socket: ${err}`);
	}
}

// --- Command/Response correlation ---

function sendCommand(managed: ManagedSession, cmd: Record<string, any>): Promise<any> {
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
				console.warn(`RPC command timed out: ${cmd.type} (session: ${managed.sessionId})`);
				reject(new Error(`RPC command timed out: ${cmd.type}`));
			}
		}, COMMAND_TIMEOUT_MS);
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
				if (managed.autoStopTimer) {
					clearTimeout(managed.autoStopTimer);
					managed.autoStopTimer = null;
				}
			}
			if (parsed.type === 'agent_end') {
				managed.isStreaming = false;
				managed.lastAgentStartTime = null;
				managed.streamingAssistantText = '';
				managed.streamingThinkingText = '';
				if (managed.autoStopTimer) clearTimeout(managed.autoStopTimer);
				managed.autoStopTimer = setTimeout(() => {
					managed.autoStopTimer = null;
					if (!managed.isStreaming && activeSessions.has(managed.sessionId)) {
						stopSession(managed.sessionId);
					}
				}, AUTO_STOP_DELAY_MS);
			}
			if (parsed.type === 'session_ended') {
				handleSessionEnded(managed);
				return; // Stop processing — session is done
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
	console.log(`Spawning relay: ${RELAY_SCRIPT} ${socketPath} ${cwd} ${piArgs.join(' ')}`);

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
				console.log(`Relay ready: pid ${pid}`);
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
					open() {},
					close() {
						if (activeSessions.has(managed.sessionId) && managed.socket) {
							managed.socket = null;
							handleSessionEnded(managed);
						}
					},
					error(_socket, err) {
						console.error(`Socket error for ${managed.sessionId}:`, err.message);
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
		};

		await connectToRelay(managed);
		activeSessions.set(sessionId, managed);
		updatePidStmt.run(relayPid, 'running', sessionId);

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
	if (!managed) throw new Error('Session not active');
	return sendCommand(managed, { type: 'get_commands' });
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

		const socketPath = row.socket_path || socketPathFor(row.session_id);
		const relayPid = getRelayPid(socketPath);

		if (relayPid) {
			// Relay is still alive! Just reconnect.
			console.log(`Reconnecting to live relay: ${row.session_id} (pid ${relayPid})`);
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

				reconnected++;
				continue;
			} catch (err) {
				console.error(`Failed to reconnect to relay ${row.session_id}:`, err);
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
		console.log(`Recovery: ${reconnected} reconnected, ${recovered} respawned (of ${rows.length} total)`);
	}
}

// --- Graceful shutdown ---

async function handleShutdown() {
	console.log('Shutting down — disconnecting from relays (agents stay alive)...');

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
