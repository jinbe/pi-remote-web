/**
 * Pure Claude Code → pi RPC event translation logic.
 *
 * Extracted from claude-relay.ts so that it can be shared between the relay
 * daemon and its test suite without spawning processes or binding sockets.
 */

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
		...overrides,
	};
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

	// Capture session_id from the first event that carries one
	if (onSessionId && event.session_id) {
		state.sessionId = event.session_id;
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
				output.push({ type: 'agent_start' });
				output.push({ type: 'turn_start' });
				output.push({
					type: 'message_start',
					message: { role: 'assistant' },
				});
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

			// After tool results, a new turn may start — reset text tracking for next assistant message
			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			output.push({ type: 'turn_start' });
			output.push({
				type: 'message_start',
				message: { role: 'assistant' },
			});
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
			state.currentToolCalls.clear();
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
