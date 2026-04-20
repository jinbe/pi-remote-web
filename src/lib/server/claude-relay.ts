#!/usr/bin/env bun
/**
 * Claude Code Relay Daemon
 *
 * Drop-in replacement for pi-relay.ts that spawns `claude` instead of `pi`.
 * Translates between Claude Code's stream-json protocol and pi's RPC protocol
 * so that rpc-manager.ts can work unchanged.
 *
 * Usage: bun claude-relay.ts <socket-path> <cwd> [claude-args...]
 *   e.g. bun claude-relay.ts /tmp/pi-session-abc.sock /home/user/project --resume <uuid>
 *   e.g. bun claude-relay.ts /tmp/pi-session-abc.sock /home/user/project --model sonnet
 */

import { unlinkSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { Socket, Subprocess } from 'bun';
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
	const encodedCwd = cwd.replace(/\//g, '-');
	return join(homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}

const state: SyntheticState = createSyntheticState();

// Mutable spawn args — we strip and re-add --resume/--model/--effort across restarts
let currentModel: string | null = extractFlag(claudeArgs, '--model');
let currentEffort: string | null = extractFlag(claudeArgs, '--effort');
let baseArgs: string[] = stripFlags(claudeArgs, ['--model', '--effort', '--resume']);
let initialResumeId: string | null = extractFlag(claudeArgs, '--resume');

function extractFlag(args: string[], flag: string): string | null {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return null;
	return args[idx + 1];
}

function stripFlags(args: string[], flags: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i])) {
			i++;
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

// --- Session ID readiness ---

let sessionIdCaptured = false;
let sessionIdResolve: (() => void) | null = null;
const sessionIdReady = new Promise<void>((resolve) => {
	sessionIdResolve = resolve;
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

function buildSpawnArgs(): string[] {
	const args = [
		claudeBin,
		'-p',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--dangerously-skip-permissions',
		...baseArgs,
	];
	if (currentModel) args.push('--model', currentModel);
	if (currentEffort) args.push('--effort', currentEffort);
	// Use captured session ID for restarts; fall back to initial --resume on first spawn
	const resumeId = sessionIdCaptured && state.sessionId ? state.sessionId : initialResumeId;
	if (resumeId) args.push('--resume', resumeId);
	return args;
}

let proc: Subprocess<'pipe', 'pipe', 'pipe'>;
let intentionalRestart = false;
let restartInProgress: Promise<void> | null = null;

function spawnClaude(): void {
	const spawnArgs = buildSpawnArgs();
	relayLog(`spawning: ${spawnArgs.join(' ')} in ${cwd}`);
	proc = Bun.spawn(spawnArgs, {
		cwd,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	bindStdoutReader(proc);
	bindStderrReader(proc);
	bindExitHandler(proc);
}

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

function onSessionIdCaptured(id: string): void {
	if (sessionIdCaptured) return;
	state.sessionFile = buildSessionFilePath(id);
	sessionIdCaptured = true;
	sessionIdResolve?.();
	relayLog(`captured session ID: ${state.sessionId} file=${state.sessionFile}`);
}

function handleClaudeEvent(event: any): void {
	const piEvents = translateClaudeEvent(
		state,
		event,
		sessionIdCaptured ? undefined : onSessionIdCaptured,
	);

	if (event.type === 'system' && event.subtype === 'init') {
		relayLog(`init: model=${state.model} session=${state.sessionId}`);
	} else if (event.type === 'rate_limit_event') {
		relayLog(`rate limit: ${JSON.stringify(event.rate_limit_info)}`);
	}

	for (const piEvent of piEvents) {
		broadcast(JSON.stringify(piEvent));
		// On result/agent_end, drain any queued follow-up messages
		if (piEvent.type === 'agent_end') {
			drainMessageQueue();
		}
	}
}

// --- Read Claude stdout (rebound on each spawn) ---

function bindStdoutReader(p: Subprocess<'pipe', 'pipe', 'pipe'>): void {
	const reader = (p.stdout as ReadableStream).getReader();
	const decoder = new TextDecoder();
	let stdoutBuffer = '';

	(async () => {
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
	})().catch((err) => relayLog(`stdout pump error: ${err}`));
}

function bindStderrReader(p: Subprocess<'pipe', 'pipe', 'pipe'>): void {
	if (!p.stderr) return;
	const stderrReader = (p.stderr as ReadableStream).getReader();
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

function bindExitHandler(p: Subprocess<'pipe', 'pipe', 'pipe'>): void {
	p.exited.then((code) => {
		const signalCode = p.signalCode;
		relayLog(`claude exited: code=${code} signal=${signalCode} pid=${p.pid} intentional=${intentionalRestart}`);

		// If we killed it ourselves for a restart, the new spawn will handle continuity
		if (intentionalRestart) return;

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
}

// --- Message queue (for follow-ups while streaming) ---

interface QueuedMessage {
	message: string;
	images?: Array<{ type: 'image'; data: string; mimeType: string }>;
}
const messageQueue: QueuedMessage[] = [];

function drainMessageQueue(): void {
	if (messageQueue.length === 0) return;
	// Pull all queued messages and join; Claude will see them as one user turn.
	// This avoids waiting an extra round-trip per queued follow-up.
	const next = messageQueue.shift()!;
	relayLog(`draining queued message (${messageQueue.length} remaining)`);
	state.messages.push({ role: 'user', content: next.message, timestamp: Date.now() });
	const payload = buildUserOrToolResult(next.message, next.images);
	writeToClaudeStdin(JSON.stringify(payload) + '\n');
}

function buildClaudeUserPayload(text: string, images?: Array<{ data: string; mimeType: string }>): any {
	if (!images || images.length === 0) {
		return { type: 'user', message: { role: 'user', content: text } };
	}
	const content: any[] = [];
	if (text) content.push({ type: 'text', text });
	for (const img of images) {
		content.push({
			type: 'image',
			source: {
				type: 'base64',
				media_type: img.mimeType,
				data: img.data,
			},
		});
	}
	return { type: 'user', message: { role: 'user', content } };
}

/**
 * If the prior turn ended with the assistant invoking a tool that asks the
 * user something (AskUserQuestion, ExitPlanMode, …), Claude is waiting for a
 * `tool_result` keyed by that tool_use_id — not a fresh user turn. Sending a
 * plain user message would discard the question context. Wrap the user's
 * reply as a tool_result for the most recent pending tool call instead.
 *
 * Returns null if there are no pending tools (caller should fall back to the
 * normal user-message payload).
 */
function buildPendingToolResultPayload(text: string): any | null {
	if (state.currentToolCalls.size === 0) return null;
	// Use the most recently added pending tool — Maps preserve insertion order
	const lastEntry = Array.from(state.currentToolCalls.entries()).pop();
	if (!lastEntry) return null;
	const [toolCallId] = lastEntry;
	state.currentToolCalls.delete(toolCallId);
	relayLog(`wrapping reply as tool_result for pending tool ${toolCallId}`);
	return {
		type: 'user',
		message: {
			role: 'user',
			content: [{
				type: 'tool_result',
				tool_use_id: toolCallId,
				content: text,
			}],
		},
	};
}

/** Build the right Claude stdin payload for a user message — tool_result if a pending
 * interactive tool is waiting, otherwise a normal user message (with optional images). */
function buildUserOrToolResult(text: string, images?: Array<{ data: string; mimeType: string }>): any {
	// Images can only be attached to plain user messages, not tool_results.
	if (images && images.length > 0) {
		return buildClaudeUserPayload(text, images);
	}
	return buildPendingToolResultPayload(text) ?? buildClaudeUserPayload(text);
}

// --- Soft interrupt (kill Claude, resume same session) ---

async function restartClaude(reason: string): Promise<void> {
	if (restartInProgress) return restartInProgress;
	restartInProgress = (async () => {
		intentionalRestart = true;
		relayLog(`soft restart: ${reason}`);
		const oldProc = proc;
		try {
			oldProc.kill('SIGTERM');
			await Promise.race([
				oldProc.exited,
				new Promise((r) => setTimeout(r, 2000)),
			]);
			if (oldProc.exitCode === null) {
				try { oldProc.kill('SIGKILL'); } catch {}
				await oldProc.exited;
			}

			// If we were mid-stream, synthesize a clean turn-end so subscribers know
			if (state.isStreaming) {
				broadcast(JSON.stringify({
					type: 'message_end',
					message: { role: 'assistant' },
				}));
				broadcast(JSON.stringify({
					type: 'turn_end',
					message: { role: 'assistant' },
					toolResults: [],
				}));
				broadcast(JSON.stringify({
					type: 'agent_end',
					messages: state.messages.slice(-10),
					_lastAssistantText: state.currentAssistantText,
					_aborted: true,
				}));
			}
			state.isStreaming = false;
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentToolCalls.clear();
			state.streamBlocks.clear();

			// Spawn replacement
			spawnClaude();
		} finally {
			intentionalRestart = false;
			restartInProgress = null;
		}
	})();
	return restartInProgress;
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
			const images = parsed.images;

			if (state.isStreaming) {
				// Default to follow-up behavior when streaming and no behavior specified
				const behavior = parsed.streamingBehavior || 'followUp';
				if (behavior === 'steer') {
					await restartClaude('steer');
					state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
					writeToClaudeStdin(JSON.stringify(buildUserOrToolResult(message, images)) + '\n');
					respond(id, 'prompt', true);
				} else {
					messageQueue.push({ message, images });
					respond(id, 'prompt', true, { queued: true, queueDepth: messageQueue.length });
				}
				break;
			}

			state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
			writeToClaudeStdin(JSON.stringify(buildUserOrToolResult(message, images)) + '\n');
			respond(id, 'prompt', true);
			break;
		}

		case 'steer': {
			const message = parsed.message || '';
			const images = parsed.images;
			// Steer = stop what you're doing and do this instead
			if (state.isStreaming) {
				await restartClaude('steer rpc');
			}
			state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
			writeToClaudeStdin(JSON.stringify(buildUserOrToolResult(message, images)) + '\n');
			respond(id, 'steer', true);
			break;
		}

		case 'follow_up': {
			const message = parsed.message || '';
			const images = parsed.images;
			// Follow-up = queue if streaming; send immediately if idle
			if (state.isStreaming) {
				messageQueue.push({ message, images });
				respond(id, 'follow_up', true, { queued: true, queueDepth: messageQueue.length });
				break;
			}
			state.messages.push({ role: 'user', content: message, timestamp: Date.now() });
			writeToClaudeStdin(JSON.stringify(buildUserOrToolResult(message, images)) + '\n');
			respond(id, 'follow_up', true);
			break;
		}

		case 'abort': {
			// Soft abort — kill current claude and respawn with --resume so the session continues
			restartClaude('abort rpc').catch((err) => {
				relayLog(`abort restart error: ${(err as Error).message}`);
			});
			respond(id, 'abort', true);
			break;
		}

		case 'get_state': {
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
				thinkingLevel: currentEffort || 'medium',
				isStreaming: state.isStreaming,
				isCompacting: false,
				steeringMode: 'all',
				followUpMode: 'one-at-a-time',
				sessionFile: state.sessionFile,
				sessionId: state.sessionId,
				autoCompactionEnabled: false,
				messageCount: state.messages.length,
				pendingMessageCount: messageQueue.length,
				awaitingUserInput: state.currentToolCalls.size > 0,
				pendingToolCalls: Array.from(state.currentToolCalls.entries()).map(([id, info]) => ({
					id,
					name: info.name,
					args: info.args,
				})),
			});
			break;
		}

		case 'get_messages': {
			respond(id, 'get_messages', true, { messages: state.messages });
			break;
		}

		case 'get_session_stats': {
			respond(id, 'get_session_stats', true, {
				sessionFile: state.sessionFile,
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
			// Discovery happens on the rpc-manager side via slash-commands scanner.
			// Return empty here — caller falls back to the scanner result.
			respond(id, 'get_commands', true, { commands: [] });
			break;
		}

		case 'compact': {
			// Shim: trigger compaction by sending /compact as a user message.
			// Claude Code interprets slash commands inline in print mode.
			const focus = parsed.focus ? ` ${parsed.focus}` : '';
			const compactMsg = `/compact${focus}`;
			if (state.isStreaming) {
				messageQueue.push({ message: compactMsg });
				respond(id, 'compact', true, { queued: true });
			} else {
				writeToClaudeStdin(JSON.stringify(buildClaudeUserPayload(compactMsg)) + '\n');
				respond(id, 'compact', true);
			}
			break;
		}

		case 'set_model': {
			// Model change requires a restart with --model; the session resumes intact via --resume
			const newModel = parsed.model;
			if (!newModel) {
				respond(id, 'set_model', false, undefined, 'Missing `model` parameter');
				break;
			}
			currentModel = newModel;
			restartClaude(`set_model=${newModel}`).then(() => {
				respond(id, 'set_model', true);
			}).catch((err) => {
				respond(id, 'set_model', false, undefined, (err as Error).message);
			});
			break;
		}

		case 'set_thinking_level': {
			// Maps to Claude Code's --effort flag (low/medium/high/max/auto).
			// Requires restart; session resumes intact via --resume.
			const level = parsed.level;
			if (!level) {
				respond(id, 'set_thinking_level', false, undefined, 'Missing `level` parameter');
				break;
			}
			currentEffort = level;
			restartClaude(`set_thinking_level=${level}`).then(() => {
				respond(id, 'set_thinking_level', true);
			}).catch((err) => {
				respond(id, 'set_thinking_level', false, undefined, (err as Error).message);
			});
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

// --- Spawn the first Claude process ---

spawnClaude();

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

// --- Signal handling ---

function handleSignal(signal: string) {
	relayLog(`received signal: ${signal} — killing claude (pid=${proc.pid})`);
	try { proc.kill(); } catch {}
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGUSR1', () => handleSignal('SIGUSR1'));

// Signal readiness
process.stdout.write(JSON.stringify({ type: 'relay_ready', pid: process.pid, socketPath }) + '\n');
try { process.stdout.end(); } catch {}
