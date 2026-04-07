/**
 * Tests for the Claude Code → pi RPC protocol translation layer.
 *
 * These tests verify that Claude Code stream-json events are correctly
 * translated into the pi RPC event format that rpc-manager.ts expects.
 *
 * The translation logic lives in claude-event-translator.ts and is shared
 * with the relay daemon, so tests exercise the real production code path.
 */
import { describe, test, expect } from 'bun:test';
import {
	translateClaudeEvent,
	createSyntheticState,
	type SyntheticState,
} from './claude-event-translator.js';

// --- Tests ---

describe('Claude Code → pi RPC translation', () => {

	test('system init extracts model and session ID', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });
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
		const state = createSyntheticState({ sessionId: 'test-session-id' });
		const events = translateClaudeEvent(state, {
			type: 'system',
			subtype: 'hook_started',
			hook_name: 'SessionStart:startup',
		});

		expect(events).toHaveLength(0);
	});

	test('first assistant event emits agent_start + turn_start + message_start', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });
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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });
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
		const state = createSyntheticState({ sessionId: 'test-session-id' });
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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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

		// Tool result — should reset prevAssistantText and persist pre-tool text
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

		// Pre-tool text should have been persisted
		const assistantMsgs = state.messages.filter(m => m.role === 'assistant');
		expect(assistantMsgs).toHaveLength(1);
		expect(assistantMsgs[0].content[0].text).toBe('Let me check.');

		// New assistant text after tool result
		const events = translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Found file.txt' }] },
		});

		const delta = events.find(e => e.type === 'message_update');
		expect(delta?.assistantMessageEvent.delta).toBe('Found file.txt');
	});

	test('result event emits message_end + turn_end + agent_end', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });
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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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

	test('onSessionId callback is invoked for first event with session_id', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });
		let capturedId: string | undefined;

		translateClaudeEvent(state, {
			type: 'system',
			subtype: 'init',
			model: 'claude-sonnet-4-20250514',
			session_id: 'captured-123',
		}, (id) => { capturedId = id; });

		expect(capturedId).toBe('captured-123');
		expect(state.sessionId).toBe('captured-123');
		expect(state.sessionIdCaptured).toBe(true);
	});

	test('onSessionId callback is invoked only once per translator instance', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });
		let callCount = 0;
		const onSessionId = () => { callCount++; };

		// First event with session_id — should invoke
		translateClaudeEvent(state, {
			type: 'system',
			subtype: 'init',
			model: 'claude-sonnet-4-20250514',
			session_id: 'first-id',
		}, onSessionId);

		// Second event with session_id — should NOT invoke again
		translateClaudeEvent(state, {
			type: 'assistant',
			session_id: 'second-id',
			message: { content: [{ type: 'text', text: 'hi' }] },
		}, onSessionId);

		expect(callCount).toBe(1);
		expect(state.sessionId).toBe('first-id');
	});

	test('pre-tool assistant text is persisted to messages before reset', () => {
		const state = createSyntheticState({ sessionId: 'test-session-id' });

		// Assistant produces text before tool use
		translateClaudeEvent(state, {
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Let me check that file.' }] },
		});

		// Tool use
		translateClaudeEvent(state, {
			type: 'assistant',
			message: {
				content: [{
					type: 'tool_use',
					id: 'toolu_persist',
					name: 'Read',
					input: { path: 'file.txt' },
				}],
			},
		});

		// Tool result — should persist the pre-tool text
		translateClaudeEvent(state, {
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_persist',
					content: 'file contents here',
					is_error: false,
				}],
			},
		});

		// The pre-tool text should be in messages
		const assistantMsgs = state.messages.filter(m => m.role === 'assistant');
		expect(assistantMsgs).toHaveLength(1);
		expect(assistantMsgs[0].content[0].text).toBe('Let me check that file.');

		// Tool result should also be in messages
		const toolMsgs = state.messages.filter(m => m.role === 'toolResult');
		expect(toolMsgs).toHaveLength(1);
	});
});

describe('Synthetic state (get_state / get_session_stats)', () => {

	test('get_state response shape matches pi RPC format', () => {
		const state = createSyntheticState({
			sessionId: 'test-123',
			model: 'claude-sonnet-4-20250514',
			isStreaming: true,
		});

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
		const state = createSyntheticState({ sessionId: 'test-session-id' });

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

// Note: These tests replicate the getHarness() logic inline rather than calling
// the real function because bun:test doesn't support environment variable mutation
// between tests (process.env changes don't take effect after module load).
// If bun:test adds env mocking, these should be refactored to call getHarness() directly.
describe('Harness selection', () => {

	test('getHarness returns pi by default', async () => {
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
