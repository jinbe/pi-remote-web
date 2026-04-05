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
import { tmpdir } from 'os';
import type { Socket } from 'bun';

const [socketPath, cwd, ...claudeArgs] = process.argv.slice(2);

if (!socketPath || !cwd) {
	console.error('Usage: bun claude-relay.ts <socket-path> <cwd> [claude-args...]');
	process.exit(1);
}

const pidPath = socketPath.replace(/\.sock$/, '.pid');

// Clean up stale socket
try { unlinkSync(socketPath); } catch {}

// --- Logging ---

const LOG_FILE = join(tmpdir(), 'pi-remote-web', 'debug.log');
function relayLog(msg: string) {
	try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [INFO] [claude-relay] ${msg}\n`); } catch {}
}

// --- Synthetic state ---

interface SyntheticState {
	sessionId: string;
	model: string | null;
	isStreaming: boolean;
	messages: any[];
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	currentAssistantText: string;
	currentThinkingText: string;
	currentToolCalls: Map<string, { name: string; args: any; text: string }>;
	/** Tracks the previous assistant text snapshot so we can compute deltas */
	prevAssistantText: string;
	prevThinkingText: string;
}

const state: SyntheticState = {
	sessionId: crypto.randomUUID(),
	model: null,
	isStreaming: false,
	messages: [],
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
	totalCost: 0,
	currentAssistantText: '',
	currentThinkingText: '',
	currentToolCalls: new Map(),
	prevAssistantText: '',
	prevThinkingText: '',
};

// --- Pending RPC commands (commands from the web UI that need synthetic responses) ---

interface PendingCommand {
	id: string;
	type: string;
}

const pendingCommands: PendingCommand[] = [];

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

function translateClaudeEvent(event: any): void {
	const eventType = event.type;

	switch (eventType) {
		case 'system': {
			if (event.subtype === 'init') {
				// Claude Code init — extract model and session ID
				state.model = event.model || null;
				if (event.session_id) state.sessionId = event.session_id;
				relayLog(`init: model=${state.model} session=${state.sessionId}`);
			}
			// Skip hook events, they're Claude Code internal
			break;
		}

		case 'assistant': {
			const msg = event.message;
			if (!msg || !msg.content) break;

			// If we're not streaming yet, emit agent_start + turn_start
			if (!state.isStreaming) {
				state.isStreaming = true;
				state.currentAssistantText = '';
				state.currentThinkingText = '';
				state.prevAssistantText = '';
				state.prevThinkingText = '';
				state.currentToolCalls.clear();
				broadcast(JSON.stringify({ type: 'agent_start' }));
				broadcast(JSON.stringify({ type: 'turn_start' }));
				broadcast(JSON.stringify({
					type: 'message_start',
					message: { role: 'assistant' },
				}));
			}

			// Extract model if not set
			if (!state.model && msg.model) {
				state.model = msg.model;
			}

			// Process content blocks
			for (const block of msg.content) {
				if (block.type === 'text') {
					const fullText = block.text || '';
					// Compute delta from previous snapshot
					const delta = fullText.slice(state.prevAssistantText.length);
					if (delta) {
						state.currentAssistantText = fullText;
						state.prevAssistantText = fullText;
						broadcast(JSON.stringify({
							type: 'message_update',
							message: { role: 'assistant' },
							assistantMessageEvent: {
								type: 'text_delta',
								contentIndex: 0,
								delta,
							},
						}));
					}
				} else if (block.type === 'thinking') {
					const fullThinking = block.thinking || '';
					const delta = fullThinking.slice(state.prevThinkingText.length);
					if (delta) {
						state.currentThinkingText = fullThinking;
						state.prevThinkingText = fullThinking;
						broadcast(JSON.stringify({
							type: 'message_update',
							message: { role: 'assistant' },
							assistantMessageEvent: {
								type: 'thinking_delta',
								contentIndex: 0,
								delta,
							},
						}));
					}
				} else if (block.type === 'tool_use') {
					const toolCallId = block.id;
					const toolName = block.name;
					const toolInput = block.input || {};

					if (!state.currentToolCalls.has(toolCallId)) {
						state.currentToolCalls.set(toolCallId, {
							name: toolName,
							args: toolInput,
							text: '',
						});
						broadcast(JSON.stringify({
							type: 'tool_execution_start',
							toolCallId,
							toolName,
							args: toolInput,
						}));
					}
				}
			}
			break;
		}

		case 'user': {
			// Tool results from Claude Code
			const msg = event.message;
			if (!msg || !msg.content) break;

			for (const block of (Array.isArray(msg.content) ? msg.content : [msg.content])) {
				if (block.type === 'tool_result') {
					const toolCallId = block.tool_use_id;
					const toolInfo = state.currentToolCalls.get(toolCallId);
					const toolName = toolInfo?.name || 'unknown';

					// Extract text content from tool result
					let resultText = '';
					if (typeof block.content === 'string') {
						resultText = block.content;
					} else if (Array.isArray(block.content)) {
						resultText = block.content
							.filter((c: any) => c.type === 'text')
							.map((c: any) => c.text)
							.join('\n');
					}

					// Also check tool_use_result for stdout
					if (event.tool_use_result?.stdout) {
						resultText = event.tool_use_result.stdout;
					}

					broadcast(JSON.stringify({
						type: 'tool_execution_end',
						toolCallId,
						toolName,
						result: {
							content: [{ type: 'text', text: resultText }],
							details: {},
						},
						isError: block.is_error || false,
					}));

					state.currentToolCalls.delete(toolCallId);

					// Store tool result message
					state.messages.push({
						role: 'toolResult',
						toolCallId,
						toolName,
						content: [{ type: 'text', text: resultText }],
						isError: block.is_error || false,
						timestamp: Date.now(),
					});
				}
			}

			// After tool results, a new turn may start — reset text tracking for next assistant message
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			broadcast(JSON.stringify({ type: 'turn_start' }));
			broadcast(JSON.stringify({
				type: 'message_start',
				message: { role: 'assistant' },
			}));
			break;
		}

		case 'result': {
			// Final result — agent is done
			const usage = event.usage || {};
			state.totalInputTokens += usage.input_tokens || 0;
			state.totalOutputTokens += usage.output_tokens || 0;
			state.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
			state.totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
			state.totalCost += event.total_cost_usd || 0;

			if (event.session_id) state.sessionId = event.session_id;

			// Store final assistant message
			if (state.currentAssistantText) {
				state.messages.push({
					role: 'assistant',
					content: [{ type: 'text', text: state.currentAssistantText }],
					model: state.model,
					timestamp: Date.now(),
				});
			}

			// Emit message_end, turn_end, agent_end
			broadcast(JSON.stringify({
				type: 'message_end',
				message: { role: 'assistant' },
			}));
			broadcast(JSON.stringify({
				type: 'turn_end',
				message: { role: 'assistant' },
				toolResults: [],
			}));

			const agentEnd: any = {
				type: 'agent_end',
				messages: state.messages.slice(-10), // Last few messages
			};
			// Attach _lastAssistantText like pi-relay does
			agentEnd._lastAssistantText = state.currentAssistantText;
			broadcast(JSON.stringify(agentEnd));

			state.isStreaming = false;
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentToolCalls.clear();

			// Resolve any pending prompt command
			const promptCmd = pendingCommands.find(c => c.type === 'prompt');
			if (promptCmd) {
				pendingCommands.splice(pendingCommands.indexOf(promptCmd), 1);
			}

			break;
		}

		case 'rate_limit_event': {
			// Log but don't forward — no pi equivalent
			relayLog(`rate limit: ${JSON.stringify(event.rate_limit_info)}`);
			break;
		}

		default: {
			// Forward unknown events as-is for debugging
			relayLog(`unhandled event type: ${eventType}`);
			break;
		}
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
				translateClaudeEvent(event);
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

function handleRpcCommand(raw: string): void {
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

			// If currently streaming, treat as steer/follow-up
			if (state.isStreaming) {
				if (parsed.streamingBehavior === 'steer' || parsed.streamingBehavior === 'followUp') {
					// Claude Code stream-json accepts additional user_message lines
					writeToClaudeStdin(JSON.stringify({ type: 'user_message', content: message }) + '\n');
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
			writeToClaudeStdin(JSON.stringify({ type: 'user_message', content: message }) + '\n');

			// Respond immediately (fire-and-forget like pi RPC)
			respond(id, 'prompt', true);
			break;
		}

		case 'steer': {
			const message = parsed.message || '';
			writeToClaudeStdin(JSON.stringify({ type: 'user_message', content: message }) + '\n');
			respond(id, 'steer', true);
			break;
		}

		case 'follow_up': {
			const message = parsed.message || '';
			// Claude Code doesn't differentiate steer vs follow-up — send immediately
			writeToClaudeStdin(JSON.stringify({ type: 'user_message', content: message }) + '\n');
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
				sessionFile: null,
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
