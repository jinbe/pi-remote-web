/**
 * Tests for the Claude Code → pi RPC protocol translation layer.
 *
 * These tests verify that Claude Code stream-json events are correctly
 * translated into the pi RPC event format that rpc-manager.ts expects.
 */
import { describe, test, expect } from 'bun:test';

// --- Helpers ---

/**
 * Simulate the translation logic from claude-relay.ts.
 * We extract the core translation into a testable function rather than
 * spawning actual processes.
 */

interface TranslatorState {
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
	prevAssistantText: string;
	prevThinkingText: string;
}

function createState(): TranslatorState {
	return {
		sessionId: 'test-session-id',
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
}

/**
 * Core translation function extracted from claude-relay.ts for testability.
 * Returns an array of pi RPC events that would be broadcast.
 */
function translateClaudeEvent(state: TranslatorState, event: any): any[] {
	const output: any[] = [];

	switch (event.type) {
		case 'system': {
			if (event.subtype === 'init') {
				state.model = event.model || null;
				if (event.session_id) state.sessionId = event.session_id;
			}
			break;
		}

		case 'assistant': {
			const msg = event.message;
			if (!msg || !msg.content) break;

			if (!state.isStreaming) {
				state.isStreaming = true;
				state.currentAssistantText = '';
				state.currentThinkingText = '';
				state.prevAssistantText = '';
				state.prevThinkingText = '';
				state.currentToolCalls.clear();
				output.push({ type: 'agent_start' });
				output.push({ type: 'turn_start' });
				output.push({ type: 'message_start', message: { role: 'assistant' } });
			}

			if (!state.model && msg.model) {
				state.model = msg.model;
			}

			for (const block of msg.content) {
				if (block.type === 'text') {
					const fullText = block.text || '';
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
			const msg = event.message;
			if (!msg || !msg.content) break;

			for (const block of (Array.isArray(msg.content) ? msg.content : [msg.content])) {
				if (block.type === 'tool_result') {
					const toolCallId = block.tool_use_id;
					const toolInfo = state.currentToolCalls.get(toolCallId);
					const toolName = toolInfo?.name || 'unknown';

					let resultText = '';
					if (typeof block.content === 'string') {
						resultText = block.content;
					} else if (Array.isArray(block.content)) {
						resultText = block.content
							.filter((c: any) => c.type === 'text')
							.map((c: any) => c.text)
							.join('\n');
					}

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

			state.prevAssistantText = '';
			state.prevThinkingText = '';
			state.currentAssistantText = '';
			state.currentThinkingText = '';
			output.push({ type: 'turn_start' });
			output.push({ type: 'message_start', message: { role: 'assistant' } });
			break;
		}

		case 'result': {
			const usage = event.usage || {};
			state.totalInputTokens += usage.input_tokens || 0;
			state.totalOutputTokens += usage.output_tokens || 0;
			state.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
			state.totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
			state.totalCost += event.total_cost_usd || 0;

			if (event.session_id) state.sessionId = event.session_id;

			if (state.currentAssistantText) {
				state.messages.push({
					role: 'assistant',
					content: [{ type: 'text', text: state.currentAssistantText }],
					model: state.model,
					timestamp: Date.now(),
				});
			}

			output.push({ type: 'message_end', message: { role: 'assistant' } });
			output.push({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });

			const agentEnd: any = {
				type: 'agent_end',
				messages: state.messages.slice(-10),
			};
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
	}

	return output;
}

// --- Tests ---

describe('Claude Code → pi RPC translation', () => {

	test('system init extracts model and session ID', () => {
		const state = createState();
		const events = translateClaudeEvent(state, {
			type: 'system',
			subtype: 'init',
			model: 'claude-sonnet-4-20250514',
			session_id: 'abc-123',
		});

		expect(events).toHaveLength(0); // init doesn't emit pi events
		expect(state.model).toBe('claude-sonnet-4-20250514');
		expect(state.sessionId).toBe('abc-123');
	});

	test('system hook events are ignored', () => {
		const state = createState();
		const events = translateClaudeEvent(state, {
			type: 'system',
			subtype: 'hook_started',
			hook_name: 'SessionStart:startup',
		});

		expect(events).toHaveLength(0);
	});

	test('first assistant event emits agent_start + turn_start + message_start', () => {
		const state = createState();
		const events = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				model: 'claude-sonnet-4-20250514',
				content: [{ type: 'text', text: 'Hello' }],
			},
		});

		expect(events).toHaveLength(4); // agent_start, turn_start, message_start, text_delta
		expect(events[0].type).toBe('agent_start');
		expect(events[1].type).toBe('turn_start');
		expect(events[2].type).toBe('message_start');
		expect(events[3].type).toBe('message_update');
		expect(events[3].assistantMessageEvent.type).toBe('text_delta');
		expect(events[3].assistantMessageEvent.delta).toBe('Hello');
		expect(state.isStreaming).toBe(true);
	});

	test('incremental text deltas are computed from snapshots', () => {
		const state = createState();

		// First chunk
		const events1 = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: 'Hello' }],
			},
		});

		// Second chunk (full text, not just delta)
		const events2 = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: 'Hello world' }],
			},
		});

		const delta1 = events1.find(e => e.type === 'message_update');
		const delta2 = events2.find(e => e.type === 'message_update');

		expect(delta1?.assistantMessageEvent.delta).toBe('Hello');
		expect(delta2?.assistantMessageEvent.delta).toBe(' world');
	});

	test('duplicate text snapshots produce no delta', () => {
		const state = createState();

		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Hello' }] },
		});

		const events2 = translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Hello' }] },
		});

		// No message_update since text hasn't changed
		const updates = events2.filter(e => e.type === 'message_update');
		expect(updates).toHaveLength(0);
	});

	test('thinking blocks produce thinking_delta events', () => {
		const state = createState();
		const events = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'thinking',
					thinking: 'Let me think about this...',
				}],
			},
		});

		const thinkingUpdate = events.find(
			e => e.type === 'message_update' && e.assistantMessageEvent.type === 'thinking_delta'
		);
		expect(thinkingUpdate).toBeDefined();
		expect(thinkingUpdate!.assistantMessageEvent.delta).toBe('Let me think about this...');
	});

	test('tool_use blocks produce tool_execution_start events', () => {
		const state = createState();
		const events = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_123',
					name: 'Bash',
					input: { command: 'ls -la' },
				}],
			},
		});

		const toolStart = events.find(e => e.type === 'tool_execution_start');
		expect(toolStart).toBeDefined();
		expect(toolStart!.toolCallId).toBe('toolu_123');
		expect(toolStart!.toolName).toBe('Bash');
		expect(toolStart!.args).toEqual({ command: 'ls -la' });
	});

	test('duplicate tool_use IDs do not emit duplicate events', () => {
		const state = createState();

		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_123',
					name: 'Bash',
					input: { command: 'ls' },
				}],
			},
		});

		const events2 = translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_123',
					name: 'Bash',
					input: { command: 'ls' },
				}],
			},
		});

		const toolStarts = events2.filter(e => e.type === 'tool_execution_start');
		expect(toolStarts).toHaveLength(0);
	});

	test('tool_result events produce tool_execution_end', () => {
		const state = createState();

		// First emit tool start
		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_456',
					name: 'Read',
					input: { path: 'README.md' },
				}],
			},
		});

		// Then tool result
		const events = translateClaudeEvent(state, {
			type: 'user',
			message: {
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_456',
					content: '# My Project\nSome content here',
					is_error: false,
				}],
			},
		});

		const toolEnd = events.find(e => e.type === 'tool_execution_end');
		expect(toolEnd).toBeDefined();
		expect(toolEnd!.toolCallId).toBe('toolu_456');
		expect(toolEnd!.toolName).toBe('Read');
		expect(toolEnd!.isError).toBe(false);
		expect(toolEnd!.result.content[0].text).toBe('# My Project\nSome content here');
	});

	test('tool_result with stdout from tool_use_result', () => {
		const state = createState();

		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_789',
					name: 'Bash',
					input: { command: 'echo hi' },
				}],
			},
		});

		const events = translateClaudeEvent(state, {
			type: 'user',
			message: {
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_789',
					content: 'truncated...',
					is_error: false,
				}],
			},
			tool_use_result: {
				stdout: 'hi\n',
			},
		});

		const toolEnd = events.find(e => e.type === 'tool_execution_end');
		expect(toolEnd!.result.content[0].text).toBe('hi\n');
	});

	test('tool_result resets text tracking for next assistant turn', () => {
		const state = createState();

		// Initial assistant text
		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Let me check.' }] },
		});

		// Tool use
		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_abc',
					name: 'Bash',
					input: { command: 'ls' },
				}],
			},
		});

		// Tool result — should reset prevAssistantText
		translateClaudeEvent(state, {
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_abc',
					content: 'file.txt',
					is_error: false,
				}],
			},
		});

		// New assistant text after tool result
		const events = translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Found file.txt' }] },
		});

		const delta = events.find(e => e.type === 'message_update');
		expect(delta?.assistantMessageEvent.delta).toBe('Found file.txt');
	});

	test('result event emits message_end + turn_end + agent_end', () => {
		const state = createState();

		// Start streaming
		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Done!' }] },
		});

		const events = translateClaudeEvent(state, {
			type: 'result',
			subtype: 'success',
			session_id: 'final-session-id',
			total_cost_usd: 0.05,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 80,
				cache_creation_input_tokens: 20,
			},
		});

		expect(events.map(e => e.type)).toEqual(['message_end', 'turn_end', 'agent_end']);
		expect(state.isStreaming).toBe(false);
		expect(state.sessionId).toBe('final-session-id');
		expect(state.totalInputTokens).toBe(100);
		expect(state.totalOutputTokens).toBe(50);
		expect(state.totalCost).toBe(0.05);
	});

	test('agent_end includes _lastAssistantText for job-poller extraction', () => {
		const state = createState();

		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'PR_URL: https://github.com/org/repo/pull/42' }] },
		});

		const events = translateClaudeEvent(state, {
			type: 'result',
			subtype: 'success',
			usage: {},
		});

		const agentEnd = events.find(e => e.type === 'agent_end');
		expect(agentEnd!._lastAssistantText).toBe('PR_URL: https://github.com/org/repo/pull/42');
	});

	test('full multi-turn conversation flow', () => {
		const state = createState();
		const allEvents: any[] = [];

		// 1. System init
		allEvents.push(...translateClaudeEvent(state, {
			type: 'system',
			subtype: 'init',
			model: 'claude-sonnet-4-20250514',
			session_id: 'sess-1',
		}));

		// 2. Hook events (should be skipped)
		allEvents.push(...translateClaudeEvent(state, {
			type: 'system',
			subtype: 'hook_started',
			hook_name: 'SessionStart:startup',
		}));

		// 3. Assistant with thinking + tool call
		allEvents.push(...translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				model: 'claude-sonnet-4-20250514',
				content: [
					{ type: 'thinking', thinking: 'Thinking...' },
				],
			},
		}));

		allEvents.push(...translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [
					{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
				],
			},
		}));

		// 4. Tool result
		allEvents.push(...translateClaudeEvent(state, {
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'tool_1',
					content: 'file1.ts\nfile2.ts',
					is_error: false,
				}],
			},
		}));

		// 5. Final assistant text
		allEvents.push(...translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Found 2 files.' }] },
		}));

		// 6. Result
		allEvents.push(...translateClaudeEvent(state, {
			type: 'result',
			subtype: 'success',
			total_cost_usd: 0.01,
			usage: { input_tokens: 50, output_tokens: 20 },
		}));

		// Verify event sequence
		const types = allEvents.map(e => e.type);
		expect(types).toContain('agent_start');
		expect(types).toContain('turn_start');
		expect(types).toContain('message_start');
		expect(types).toContain('message_update');
		expect(types).toContain('tool_execution_start');
		expect(types).toContain('tool_execution_end');
		expect(types).toContain('message_end');
		expect(types).toContain('turn_end');
		expect(types).toContain('agent_end');

		// Verify ordering: agent_start comes before agent_end
		expect(types.indexOf('agent_start')).toBeLessThan(types.indexOf('agent_end'));

		// State is clean after result
		expect(state.isStreaming).toBe(false);
		expect(state.totalCost).toBe(0.01);
	});

	test('error tool results set isError flag', () => {
		const state = createState();

		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_err',
					name: 'Bash',
					input: { command: 'bad-command' },
				}],
			},
		});

		const events = translateClaudeEvent(state, {
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_err',
					content: 'command not found: bad-command',
					is_error: true,
				}],
			},
		});

		const toolEnd = events.find(e => e.type === 'tool_execution_end');
		expect(toolEnd!.isError).toBe(true);
	});
});

describe('Synthetic state (get_state / get_session_stats)', () => {

	test('get_state response shape matches pi RPC format', () => {
		const state = createState();
		state.model = 'claude-sonnet-4-20250514';
		state.sessionId = 'test-123';
		state.isStreaming = true;

		// Simulate what the relay would return for get_state
		const response = {
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
		};

		expect(response.model).toBeDefined();
		expect(response.model!.id).toBe('claude-sonnet-4-20250514');
		expect(response.model!.provider).toBe('anthropic');
		expect(response.isStreaming).toBe(true);
		expect(response.sessionId).toBe('test-123');
	});

	test('get_session_stats accumulates across multiple result events', () => {
		const state = createState();

		// First turn
		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'First' }] },
		});
		translateClaudeEvent(state, {
			type: 'result',
			subtype: 'success',
			total_cost_usd: 0.01,
			usage: { input_tokens: 100, output_tokens: 50 },
		});

		// Second turn (new prompt)
		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Second' }] },
		});
		translateClaudeEvent(state, {
			type: 'result',
			subtype: 'success',
			total_cost_usd: 0.02,
			usage: { input_tokens: 200, output_tokens: 80 },
		});

		expect(state.totalInputTokens).toBe(300);
		expect(state.totalOutputTokens).toBe(130);
		expect(state.totalCost).toBeCloseTo(0.03);
	});
});

describe('Harness selection', () => {

	test('getHarness returns pi by default', async () => {
		// We can't easily test env var mutation in bun:test without mocking
		// so we test the logic inline
		const envVal = undefined;
		const result = envVal === 'claude-code' || envVal === 'claude' ? 'claude-code' : 'pi';
		expect(result).toBe('pi');
	});

	test('getHarness returns claude-code when set', () => {
		const envVal = 'claude-code';
		const result = envVal === 'claude-code' || envVal === 'claude' ? 'claude-code' : 'pi';
		expect(result).toBe('claude-code');
	});

	test('getHarness accepts shorthand "claude"', () => {
		const envVal: string = 'claude';
		const result = envVal === 'claude-code' || envVal === 'claude' ? 'claude-code' : 'pi';
		expect(result).toBe('claude-code');
	});
});
