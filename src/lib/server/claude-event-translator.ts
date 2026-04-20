/**
 * Pure Claude Code → pi RPC event translation logic.
 *
 * Extracted from claude-relay.ts so that it can be shared between the relay
 * daemon and its test suite without spawning processes or binding sockets.
 */

/**
 * Per-content-block streaming state for `stream_event` partial messages.
 * Indexed by Claude's content_block index within the current assistant message.
 */
export interface StreamBlock {
	type: 'text' | 'thinking' | 'tool_use';
	/** Tool call ID — only set for tool_use blocks. */
	toolCallId?: string;
	/** Accumulated input_json_delta partials — only used for tool_use blocks. */
	inputJson?: string;
}

/**
 * Tracks the translator's running state across a session.
 * The relay daemon owns a single instance; tests create fresh ones per case.
 */
export interface SyntheticState {
	sessionId: string;
	sessionFile: string | null;
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
	/** Whether onSessionId has already been invoked for this translator instance */
	sessionIdCaptured: boolean;
	/** Per-content-block state for partial `stream_event` deltas */
	streamBlocks: Map<number, StreamBlock>;
	/** Token usage from in-flight message_start.usage; finalized on result */
	pendingInputTokens: number;
	pendingCacheReadTokens: number;
	pendingCacheWriteTokens: number;
}

/** Create a fresh default state — useful for tests. */
export function createSyntheticState(overrides?: Partial<SyntheticState>): SyntheticState {
	return {
		sessionId: crypto.randomUUID(),
		sessionFile: null,
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
		sessionIdCaptured: false,
		streamBlocks: new Map(),
		pendingInputTokens: 0,
		pendingCacheReadTokens: 0,
		pendingCacheWriteTokens: 0,
		...overrides,
	};
}

/**
 * Reset all per-turn streaming bookkeeping. Called when a turn begins
 * (first stream_event or first cumulative assistant message).
 */
function beginStreamingTurn(state: SyntheticState, output: any[]): void {
	state.isStreaming = true;
	state.currentAssistantText = '';
	state.currentThinkingText = '';
	state.prevAssistantText = '';
	state.prevThinkingText = '';
	state.currentToolCalls.clear();
	state.streamBlocks.clear();
	output.push({ type: 'agent_start' });
	output.push({ type: 'turn_start' });
	output.push({
		type: 'message_start',
		message: { role: 'assistant' },
	});
}

/**
 * Translate a single Claude Code stream-json event into zero or more pi RPC
 * events, mutating `state` as a side effect.
 *
 * When `onSessionId` is provided it is called the first time a `session_id`
 * field is seen on any event — the relay uses this to resolve its
 * session-ready promise.
 *
 * Returns the array of pi RPC event objects that should be broadcast to
 * connected clients.
 */
export function translateClaudeEvent(
	state: SyntheticState,
	event: any,
	onSessionId?: (id: string) => void,
): any[] {
	const output: any[] = [];

	// Capture session_id from the first event that carries one (once only)
	if (onSessionId && event.session_id && !state.sessionIdCaptured) {
		state.sessionId = event.session_id;
		state.sessionIdCaptured = true;
		onSessionId(event.session_id);
	}

	const eventType = event.type;

	switch (eventType) {
		case 'system': {
			if (event.subtype === 'init') {
				state.model = event.model || null;
				if (event.session_id) state.sessionId = event.session_id;
			}
			// Skip hook events — Claude Code internal
			break;
		}

		case 'stream_event': {
			const inner = event.event;
			if (!inner) break;

			switch (inner.type) {
				case 'message_start': {
					if (!state.isStreaming) beginStreamingTurn(state, output);
					const usage = inner.message?.usage;
					if (usage) {
						state.pendingInputTokens = usage.input_tokens ?? 0;
						state.pendingCacheReadTokens = usage.cache_read_input_tokens ?? 0;
						state.pendingCacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
					}
					if (inner.message?.model && !state.model) state.model = inner.message.model;
					break;
				}

				case 'content_block_start': {
					const idx = inner.index;
					const block = inner.content_block;
					if (block == null || typeof idx !== 'number') break;

					if (block.type === 'tool_use') {
						const toolCallId = block.id;
						const toolName = block.name;
						state.streamBlocks.set(idx, {
							type: 'tool_use',
							toolCallId,
							inputJson: '',
						});
						if (!state.currentToolCalls.has(toolCallId)) {
							state.currentToolCalls.set(toolCallId, {
								name: toolName,
								args: block.input || {},
								text: '',
							});
							output.push({
								type: 'tool_execution_start',
								toolCallId,
								toolName,
								args: block.input || {},
							});
						}
					} else if (block.type === 'text') {
						state.streamBlocks.set(idx, { type: 'text' });
					} else if (block.type === 'thinking') {
						state.streamBlocks.set(idx, { type: 'thinking' });
					}
					break;
				}

				case 'content_block_delta': {
					const idx = inner.index;
					const delta = inner.delta;
					const blockState = typeof idx === 'number' ? state.streamBlocks.get(idx) : undefined;
					if (!delta || !blockState) break;

					if (delta.type === 'text_delta' && blockState.type === 'text') {
						const text = delta.text || '';
						if (text) {
							state.currentAssistantText += text;
							state.prevAssistantText += text;
							output.push({
								type: 'message_update',
								message: { role: 'assistant' },
								assistantMessageEvent: {
									type: 'text_delta',
									contentIndex: 0,
									delta: text,
								},
							});
						}
					} else if (delta.type === 'thinking_delta' && blockState.type === 'thinking') {
						const text = delta.thinking || '';
						if (text) {
							state.currentThinkingText += text;
							state.prevThinkingText += text;
							output.push({
								type: 'message_update',
								message: { role: 'assistant' },
								assistantMessageEvent: {
									type: 'thinking_delta',
									contentIndex: 0,
									delta: text,
								},
							});
						}
					} else if (delta.type === 'input_json_delta' && blockState.type === 'tool_use') {
						blockState.inputJson = (blockState.inputJson || '') + (delta.partial_json || '');
					}
					break;
				}

				case 'content_block_stop': {
					const idx = inner.index;
					const blockState = typeof idx === 'number' ? state.streamBlocks.get(idx) : undefined;
					if (!blockState) break;

					// Finalize tool_use args from accumulated JSON partials
					if (blockState.type === 'tool_use' && blockState.toolCallId && blockState.inputJson) {
						try {
							const parsed = JSON.parse(blockState.inputJson);
							const toolInfo = state.currentToolCalls.get(blockState.toolCallId);
							if (toolInfo) toolInfo.args = parsed;
						} catch {
							// partial_json never closed cleanly — ignore, cumulative `assistant`
							// snapshot will fix it up if/when it arrives
						}
					}
					state.streamBlocks.delete(idx);
					break;
				}

				case 'message_delta': {
					// Per-turn output token count + stop reason. Accumulate output now;
					// the outer `result` event will add input/cache totals.
					const usage = inner.usage;
					if (usage?.output_tokens != null) {
						state.totalOutputTokens += usage.output_tokens;
					}
					break;
				}

				case 'message_stop': {
					// Outer `result` event handles agent_end — no-op here.
					break;
				}
			}
			break;
		}

		case 'assistant': {
			const msg = event.message;
			if (!msg || !msg.content) break;

			// If we're not streaming yet, emit agent_start + turn_start
			if (!state.isStreaming) beginStreamingTurn(state, output);

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
						output.push({
							type: 'message_update',
							message: { role: 'assistant' },
							assistantMessageEvent: {
								type: 'text_delta',
								contentIndex: 0,
								delta,
							},
						});
					}
				} else if (block.type === 'thinking') {
					const fullThinking = block.thinking || '';
					const delta = fullThinking.slice(state.prevThinkingText.length);
					if (delta) {
						state.currentThinkingText = fullThinking;
						state.prevThinkingText = fullThinking;
						output.push({
							type: 'message_update',
							message: { role: 'assistant' },
							assistantMessageEvent: {
								type: 'thinking_delta',
								contentIndex: 0,
								delta,
							},
						});
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
						output.push({
							type: 'tool_execution_start',
							toolCallId,
							toolName,
							args: toolInput,
						});
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

					output.push({
						type: 'tool_execution_end',
						toolCallId,
						toolName,
						result: {
							content: [{ type: 'text', text: resultText }],
							details: {},
						},
						isError: block.is_error || false,
					});

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

			// Persist any accumulated pre-tool assistant text so history isn't lost
			if (state.currentAssistantText) {
				state.messages.push({
					role: 'assistant',
					content: [{ type: 'text', text: state.currentAssistantText }],
					model: state.model,
					timestamp: Date.now(),
				});
			}

			// Reset text tracking for the next assistant message. Do NOT eagerly
			// emit turn_start / message_start here — the next stream_event
			// (or cumulative `assistant` event) will open a new turn when
			// real content is about to be produced. Emitting unconditionally
			// creates empty assistant bubbles between consecutive tool calls.
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			state.streamBlocks.clear();
			break;
		}

		case 'result': {
			// Final result — agent is done. Prefer stream_event-supplied totals
			// when available (we already accumulated output via message_delta);
			// the result event still carries authoritative input/cache totals.
			const usage = event.usage || {};
			state.totalInputTokens += usage.input_tokens || state.pendingInputTokens || 0;
			// Output tokens are already accumulated incrementally via message_delta
			// when stream_event is present — only fall back to result.usage when
			// stream_event isn't being emitted.
			if (state.pendingInputTokens === 0 && usage.output_tokens) {
				state.totalOutputTokens += usage.output_tokens;
			}
			state.totalCacheReadTokens += usage.cache_read_input_tokens || state.pendingCacheReadTokens || 0;
			state.totalCacheWriteTokens += usage.cache_creation_input_tokens || state.pendingCacheWriteTokens || 0;
			state.totalCost += event.total_cost_usd || 0;
			state.pendingInputTokens = 0;
			state.pendingCacheReadTokens = 0;
			state.pendingCacheWriteTokens = 0;

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
			output.push({
				type: 'message_end',
				message: { role: 'assistant' },
			});
			output.push({
				type: 'turn_end',
				message: { role: 'assistant' },
				toolResults: [],
			});

			const agentEnd: any = {
				type: 'agent_end',
				messages: state.messages.slice(-10), // Last few messages
			};
			// Attach _lastAssistantText like pi-relay does
			agentEnd._lastAssistantText = state.currentAssistantText;
			output.push(agentEnd);

			state.isStreaming = false;
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			// Do NOT clear currentToolCalls here. Anything still in the map
			// at agent_end is a tool the assistant invoked but never received
			// a tool_result for — typically AskUserQuestion / ExitPlanMode /
			// any "ask the user" tool. The relay needs this so the next user
			// message can be sent back as a tool_result instead of a plain
			// user turn (which the agent would otherwise interpret as a new
			// request, losing the question context).
			state.streamBlocks.clear();
			break;
		}

		case 'rate_limit_event': {
			// No pi equivalent — caller can log if desired
			break;
		}

		default: {
			// Unknown event — caller can log if desired
			break;
		}
	}

	return output;
}
