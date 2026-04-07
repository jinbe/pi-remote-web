#!/usr/bin/env bun
/**
 * Claude Code Relay Daemon
 *
 * Drop-in replacement for pi-relay.ts that spawns `claude` instead of `pi`.
 * Translates between Claude Code's stream-json protocol and pi's RPC protocol
 * so that rpc-manager.ts can work unchanged.
 *
 * Usage: bun claude-relay.ts <socket-path> <cwd> [claude-args...]
 *   e.g. bun claude-relay.ts /tmp/pi-session-abc.sock /home/user/project --session-id <uuid>
 *   e.g. bun claude-relay.ts /tmp/pi-session-abc.sock /home/user/project --model sonnet
 */

import { unlinkSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { Socket } from 'bun';
import { translateClaudeEvent, createSyntheticState } from './claude-event-translator.js';
import type { SyntheticState } from './claude-event-translator.js';

const [socketPath, cwd, ...claudeArgs] = process.argv.slice(2);

if (!socketPath || !cwd) {
	console.error('Usage: bun claude-relay.ts <socket-path> <cwd> [claude-args...]');
	process.exit(1);
}

const pidPath = socketPath.replace(/\.sock$/, '.pid');

// Clean up stale socket and PID file
try { unlinkSync(socketPath); } catch {}
try { unlinkSync(pidPath); } catch {}

// --- Logging ---

const LOG_DIR = join(tmpdir(), 'pi-remote-web');
const LOG_FILE = join(LOG_DIR, 'debug.log');
function relayLog(msg: string) {
	try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [INFO] [claude-relay] ${msg}\n`); } catch {}
}

// --- Synthetic state ---

/**
 * Build a synthetic session file path that mirrors Claude Code's layout.
 * Claude stores sessions at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 */
function buildSessionFilePath(sessionId: string): string {
	// Claude Code encodes cwd by replacing / with - (keeping the leading dash)
	// e.g. /Users/jchan/code → -Users-jchan-code
	const encodedCwd = cwd.replace(/\//g, '-');
	return join(homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}

const state: SyntheticState = createSyntheticState();

// --- Session ID readiness ---

/**
 * Resolves when we've captured a session_id from any Claude event.
 * Claude emits session_id on every event (hooks, init, etc.), so we grab
 * it from the first event that carries one.
 */
let sessionIdCaptured = false;
let sessionIdResolve: (() => void) | null = null;
const sessionIdReady = new Promise<void>((resolve) => {
	sessionIdResolve = resolve;
	// Timeout after 15s — don't block forever
	setTimeout(() => {
		if (!sessionIdCaptured) {
			relayLog('session ID capture timeout — proceeding with synthetic ID');
			state.sessionFile = buildSessionFilePath(state.sessionId);
			sessionIdCaptured = true;
			resolve();
		}
	}, 15_000);
});

// --- Per-client write queue to handle backpressure ---

interface ClientState {
	socket: Socket<undefined>;
	writeQueue: Uint8Array[];
	writing: boolean;
}

const clients = new Map<Socket<undefined>, ClientState>();
const clientBuffers = new Map<Socket<undefined>, string>();
let dead = false;

function drainClient(cs: ClientState): void {
	if (!cs.writeQueue.length) {
		cs.writing = false;
		return;
	}
	cs.writing = true;

	while (cs.writeQueue.length > 0) {
		const chunk = cs.writeQueue[0];
		const written = cs.socket.write(chunk);
		if (written === 0) return;
		if (written < chunk.length) {
			cs.writeQueue[0] = chunk.slice(written);
			return;
		}
		cs.writeQueue.shift();
	}
	cs.writing = false;
}

function writeToClient(cs: ClientState, data: Uint8Array): void {
	cs.writeQueue.push(data);
	if (!cs.writing) drainClient(cs);
}

function broadcast(line: string): void {
	const encoded = new TextEncoder().encode(line + '\n');
	for (const [, cs] of clients) {
		try { writeToClient(cs, encoded); } catch { clients.delete(cs.socket); }
	}
}

function respond(id: string, command: string, success: boolean, data?: any, error?: string): void {
	const resp: any = { type: 'response', id, command, success };
	if (data !== undefined) resp.data = data;
	if (error !== undefined) resp.error = error;
	broadcast(JSON.stringify(resp));
}

// --- Spawn Claude Code ---

const claudeBin = process.env.CLAUDE_BIN || 'claude';
const spawnArgs = [
	claudeBin,
	'-p',
	'--input-format', 'stream-json',
	'--output-format', 'stream-json',
	'--verbose',
	'--include-partial-messages',
	'--dangerously-skip-permissions',
	...claudeArgs,
];

relayLog(`spawning: ${spawnArgs.join(' ')} in ${cwd}`);

const proc = Bun.spawn(spawnArgs, {
	cwd,
	stdin: 'pipe',
	stdout: 'pipe',
	stderr: 'pipe',
});

// --- Write to Claude's stdin ---

function writeToClaudeStdin(data: string): void {
	try {
		const stdin = proc.stdin as import('bun').FileSink;
		stdin.write(data);
		stdin.flush();
	} catch (err) {
		relayLog(`stdin write error: ${(err as Error).message}`);
	}
}

// --- Translate Claude Code events to pi RPC events ---

/** Callback for the shared translator — handles relay-specific side effects. */
function onSessionIdCaptured(id: string): void {
	if (sessionIdCaptured) return;
	state.sessionFile = buildSessionFilePath(id);
	sessionIdCaptured = true;
	sessionIdResolve?.();
	relayLog(`captured session ID: ${state.sessionId} file=${state.sessionFile}`);
}

/**
 * Relay-level wrapper: translates a Claude event via the shared module,
 * then broadcasts each resulting pi RPC event and logs relay-specific info.
 */
function handleClaudeEvent(event: any): void {
	const piEvents = translateClaudeEvent(
		state,
		event,
		sessionIdCaptured ? undefined : onSessionIdCaptured,
	);

	// Relay-specific logging for certain event types
	if (event.type === 'system' && event.subtype === 'init') {
		relayLog(`init: model=${state.model} session=${state.sessionId}`);
	} else if (event.type === 'rate_limit_event') {
		relayLog(`rate limit: ${JSON.stringify(event.rate_limit_info)}`);
	} else if (!['assistant', 'user', 'result', 'system'].includes(event.type)) {
		relayLog(`unhandled event type: ${event.type}`);
	}

	for (const piEvent of piEvents) {
		broadcast(JSON.stringify(piEvent));
	}
}

// --- Read Claude stdout ---

const reader = (proc.stdout as ReadableStream).getReader();
const decoder = new TextDecoder();
let stdoutBuffer = '';

async function pumpStdout() {
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		stdoutBuffer += decoder.decode(value, { stream: true });
		const lines = stdoutBuffer.split('\n');
		stdoutBuffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				handleClaudeEvent(event);
			} catch {
				relayLog(`malformed stdout line: ${line.slice(0, 200)}`);
			}
		}
	}
}
pumpStdout().catch((err) => relayLog(`stdout pump error: ${err}`));

// --- Consume stderr ---

if (proc.stderr) {
	const stderrReader = (proc.stderr as ReadableStream).getReader();
	const stderrDecoder = new TextDecoder();
	(async () => {
		while (true) {
			const { done, value } = await stderrReader.read();
			if (done) break;
			const text = stderrDecoder.decode(value, { stream: true });
			if (text.trim()) {
				relayLog(`[claude stderr] ${text.trim().slice(0, 2000)}`);
			}
		}
	})().catch(() => {});
}

// --- Handle pi RPC commands from clients ---

async function handleRpcCommand(raw: string): Promise<void> {
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}

	const id = parsed.id || '';
	const cmdType = parsed.type;

	switch (cmdType) {
		case 'prompt': {
			const message = parsed.message || '';

			// Reject image attachments — Claude Code stream-json doesn't support multimodal input
			if (parsed.images && parsed.images.length > 0) {
				respond(id, 'prompt', false, undefined, 'Image attachments are not supported by the Claude Code harness');
				break;
			}

			// If currently streaming, treat as steer/follow-up
			if (state.isStreaming) {
				if (parsed.streamingBehavior === 'steer' || parsed.streamingBehavior === 'followUp') {
					state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
					writeToClaudeStdin(JSON.stringify({
						type: 'user',
						message: { role: 'user', content: message },
					}) + '\n');
					respond(id, 'prompt', true);
				} else {
					respond(id, 'prompt', false, undefined, 'Agent is streaming. Specify streamingBehavior.');
				}
				break;
			}

			// Store user message
			state.messages.push({
				role: 'user',
				content: message,
				timestamp: Date.now(),
			});

			// Send to Claude via stream-json input
			// Claude Code expects: {"type":"user","message":{"role":"user","content":"..."}}
			writeToClaudeStdin(JSON.stringify({
				type: 'user',
				message: { role: 'user', content: message },
			}) + '\n');

			// Respond immediately (fire-and-forget like pi RPC)
			respond(id, 'prompt', true);
			break;
		}

		case 'steer': {
			const message = parsed.message || '';
			if (parsed.images && parsed.images.length > 0) {
				respond(id, 'steer', false, undefined, 'Image attachments are not supported by the Claude Code harness');
				break;
			}
			state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
			writeToClaudeStdin(JSON.stringify({
				type: 'user',
				message: { role: 'user', content: message },
			}) + '\n');
			respond(id, 'steer', true);
			break;
		}

		case 'follow_up': {
			const message = parsed.message || '';
			if (parsed.images && parsed.images.length > 0) {
				respond(id, 'follow_up', false, undefined, 'Image attachments are not supported by the Claude Code harness');
				break;
			}
			state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
			writeToClaudeStdin(JSON.stringify({
				type: 'user',
				message: { role: 'user', content: message },
			}) + '\n');
			respond(id, 'follow_up', true);
			break;
		}

		case 'abort': {
			// Send SIGINT to Claude process
			try {
				proc.kill('SIGINT');
			} catch (err) {
				relayLog(`abort error: ${(err as Error).message}`);
			}
			respond(id, 'abort', true);
			break;
		}

		case 'get_state': {
			// Wait for session ID capture from any claude event
			await sessionIdReady;
			if (!state.sessionFile) {
				state.sessionFile = buildSessionFilePath(state.sessionId);
			}
			respond(id, 'get_state', true, {
				model: state.model ? {
					id: state.model,
					name: state.model,
					provider: 'anthropic',
				} : null,
				thinkingLevel: 'medium',
				isStreaming: state.isStreaming,
				isCompacting: false,
				steeringMode: 'all',
				followUpMode: 'one-at-a-time',
				sessionFile: state.sessionFile,
				sessionId: state.sessionId,
				autoCompactionEnabled: false,
				messageCount: state.messages.length,
				pendingMessageCount: 0,
			});
			break;
		}

		case 'get_messages': {
			respond(id, 'get_messages', true, { messages: state.messages });
			break;
		}

		case 'get_session_stats': {
			respond(id, 'get_session_stats', true, {
				sessionFile: null,
				sessionId: state.sessionId,
				userMessages: state.messages.filter((m: any) => m.role === 'user').length,
				assistantMessages: state.messages.filter((m: any) => m.role === 'assistant').length,
				toolCalls: state.messages.filter((m: any) => m.role === 'toolResult').length,
				toolResults: state.messages.filter((m: any) => m.role === 'toolResult').length,
				totalMessages: state.messages.length,
				tokens: {
					input: state.totalInputTokens,
					output: state.totalOutputTokens,
					cacheRead: state.totalCacheReadTokens,
					cacheWrite: state.totalCacheWriteTokens,
					total: state.totalInputTokens + state.totalOutputTokens +
						state.totalCacheReadTokens + state.totalCacheWriteTokens,
				},
				cost: state.totalCost,
				contextUsage: null,
			});
			break;
		}

		case 'get_commands': {
			// Claude Code doesn't expose commands via stream-json
			respond(id, 'get_commands', true, { commands: [] });
			break;
		}

		case 'compact': {
			// Not supported — Claude Code handles compaction internally
			respond(id, 'compact', false, undefined, 'Compaction not available with Claude Code harness');
			break;
		}

		case 'set_model': {
			// Can't switch models mid-session with Claude Code print mode
			respond(id, 'set_model', false, undefined,
				'Model switching not supported with Claude Code harness. Restart session with --model flag.');
			break;
		}

		case 'set_thinking_level': {
			respond(id, 'set_thinking_level', false, undefined,
				'Thinking level changes not supported with Claude Code harness.');
			break;
		}

		case 'set_auto_compaction': {
			respond(id, 'set_auto_compaction', true);
			break;
		}

		case 'set_auto_retry': {
			respond(id, 'set_auto_retry', true);
			break;
		}

		case 'set_session_name': {
			respond(id, 'set_session_name', true);
			break;
		}

		case 'get_last_assistant_text': {
			const lastAssistant = [...state.messages]
				.reverse()
				.find((m: any) => m.role === 'assistant');
			const text = lastAssistant?.content?.[0]?.text || null;
			respond(id, 'get_last_assistant_text', true, { text });
			break;
		}

		default: {
			relayLog(`unsupported RPC command: ${cmdType}`);
			respond(id, cmdType, false, undefined, `Command "${cmdType}" not supported by Claude Code harness`);
			break;
		}
	}
}

// --- Unix socket server ---

const server = Bun.listen({
	unix: socketPath,
	socket: {
		data(socket, data) {
			if (dead) return;
			const prev = clientBuffers.get(socket) ?? '';
			let buffer = prev + new TextDecoder().decode(data);

			let newlineIdx: number;
			while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				if (line.trim()) handleRpcCommand(line);
			}
			clientBuffers.set(socket, buffer);
		},
		open(socket) {
			const cs: ClientState = { socket, writeQueue: [], writing: false };
			clients.set(socket, cs);
			clientBuffers.set(socket, '');
		},
		drain(socket) {
			const cs = clients.get(socket);
			if (cs) drainClient(cs);
		},
		close(socket) {
			clients.delete(socket);
			clientBuffers.delete(socket);
		},
		error(_socket, err) {
			relayLog(`socket error: ${err.message}`);
		},
	},
});

// Write PID file AFTER socket is listening
writeFileSync(pidPath, String(process.pid));

// --- When Claude exits ---

proc.exited.then((code) => {
	const signalCode = proc.signalCode;
	relayLog(`claude exited: code=${code} signal=${signalCode} pid=${proc.pid} clients=${clients.size}`);
	dead = true;
	const msg = JSON.stringify({ type: 'session_ended', exitCode: code, signal: signalCode }) + '\n';
	const encoded = new TextEncoder().encode(msg);
	for (const [, cs] of clients) {
		try {
			cs.socket.write(encoded);
			cs.socket.end();
		} catch {}
	}
	server.stop();
	try { unlinkSync(socketPath); } catch {}
	try { unlinkSync(pidPath); } catch {}
	process.exit(code ?? 0);
});

// --- Signal handling ---

function handleSignal(signal: string) {
	relayLog(`received signal: ${signal} — killing claude (pid=${proc.pid})`);
	proc.kill();
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGUSR1', () => handleSignal('SIGUSR1'));

// Signal readiness
process.stdout.write(JSON.stringify({ type: 'relay_ready', pid: process.pid, socketPath }) + '\n');
try { process.stdout.end(); } catch {}
