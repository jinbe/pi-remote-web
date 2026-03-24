import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// --- Mock rpc-manager ---
const mockCreateSession = mock(() => Promise.resolve('mock-session-id'));
const mockSendMessage = mock(() => Promise.resolve({ ok: true }));
const mockStopSession = mock(() => Promise.resolve());
const mockGetActiveSessionIds = mock(() => new Set(['sess-1', 'sess-2']));
const mockGetActiveSession = mock((id: string) => ({ cwd: '/tmp/test', model: 'test-model' }));
const mockGetStreamingState = mock((id: string) => ({ isStreaming: false, lastAgentStartTime: null as number | null }));
const mockSubscribe = mock((id: string, cb: (event: any) => void) => () => {});
const mockIsActive = mock((id: string) => true);
const mockGetState = mock(() => Promise.resolve({ isStreaming: false }));

mock.module('./rpc-manager', () => ({
	createSession: mockCreateSession,
	sendMessage: mockSendMessage,
	stopSession: mockStopSession,
	getActiveSessionIds: mockGetActiveSessionIds,
	getActiveSession: mockGetActiveSession,
	getStreamingState: mockGetStreamingState,
	subscribe: mockSubscribe,
	isActive: mockIsActive,
	getState: mockGetState,
}));

// --- Mock session-scanner ---
const mockDecodeSessionId = mock((id: string) => `/home/test/.pi/agent/sessions/test/${id}.jsonl`);
const mockParseSessionMetadata = mock(() => Promise.resolve({
	name: 'Test Session',
	firstMessage: 'Hello',
	cwd: '/tmp/test',
	model: 'test-model',
}));
const mockGetTailMessages = mock(() => Promise.resolve({
	messages: [
		{
			type: 'message',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Hello from assistant' }],
			},
		},
	] as any[],
	hasMore: false,
}));

mock.module('./session-scanner', () => ({
	decodeSessionId: mockDecodeSessionId,
	parseSessionMetadata: mockParseSessionMetadata,
	getTailMessages: mockGetTailMessages,
}));

// --- Mock logger ---
mock.module('./logger', () => ({
	log: {
		info: () => {},
		warn: () => {},
		error: () => {},
	},
}));

// Import after mocks are set up
import {
	handleSplit,
	handleSend,
	handleRead,
	handleClose,
	handleList,
	handleNotify,
	_resetForTests,
} from './cmux-manager';

describe('cmux-manager', () => {
	beforeEach(() => {
		_resetForTests();
		mockCreateSession.mockClear();
		mockSendMessage.mockClear();
		mockStopSession.mockClear();
		mockIsActive.mockImplementation(() => true);
		mockGetStreamingState.mockImplementation(() => ({ isStreaming: false, lastAgentStartTime: null }));
	});

	describe('handleSplit', () => {
		it('creates a new session and returns surface ID', async () => {
			mockCreateSession.mockResolvedValue('new-session-abc');

			const result = await handleSplit({
				action: 'split',
				cwd: '/tmp/project',
			});

			expect(result.ok).toBe(true);
			expect(result.surface).toBe('new-session-abc');
			expect(result.sessionId).toBe('new-session-abc');
			expect(mockCreateSession).toHaveBeenCalledWith('/tmp/project', undefined);
		});

		it('passes model parameter', async () => {
			mockCreateSession.mockResolvedValue('session-with-model');

			const result = await handleSplit({
				action: 'split',
				cwd: '/tmp/project',
				model: 'claude-sonnet',
			});

			expect(result.ok).toBe(true);
			expect(mockCreateSession).toHaveBeenCalledWith('/tmp/project', 'claude-sonnet');
		});

		it('throws when cwd is missing', async () => {
			await expect(
				handleSplit({ action: 'split', cwd: '' })
			).rejects.toThrow('Missing "cwd"');
		});

		it('ignores direction parameter (compat)', async () => {
			mockCreateSession.mockResolvedValue('session-x');

			const result = await handleSplit({
				action: 'split',
				cwd: '/tmp/project',
				direction: 'down',
			});

			expect(result.ok).toBe(true);
		});
	});

	describe('handleSend', () => {
		it('buffers text when no key is provided', async () => {
			const result = await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'Hello world',
			});

			expect(result.ok).toBe(true);
			expect(result.queued).toBe(true);
			expect(mockSendMessage).not.toHaveBeenCalled();
		});

		it('dispatches buffered text on enter key', async () => {
			// Step 1: buffer text
			await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'Do something cool',
			});

			// Step 2: press enter
			const result = await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'enter',
			});

			expect(result.ok).toBe(true);
			expect(result.sent).toBe(true);
			expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'Do something cool', undefined);
		});

		it('concatenates multiple text sends before enter', async () => {
			await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'Part 1 ',
			});

			await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'Part 2',
			});

			await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'enter',
			});

			expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'Part 1 Part 2', undefined);
		});

		it('strips trailing newlines from buffered text', async () => {
			await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'Hello\n\n',
			});

			await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'enter',
			});

			expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'Hello', undefined);
		});

		it('returns sent=false for enter with no buffered text', async () => {
			const result = await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'enter',
			});

			expect(result.ok).toBe(true);
			expect(result.sent).toBe(false);
			expect(mockSendMessage).not.toHaveBeenCalled();
		});

		it('warns on unsupported keys', async () => {
			const result = await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'tab',
			});

			expect(result.ok).toBe(true);
			expect(result.sent).toBe(false);
		});

		it('throws when surface is missing', async () => {
			await expect(
				handleSend({ action: 'send', surface: '', text: 'hi' })
			).rejects.toThrow('Missing "surface"');
		});

		it('throws when session is not active', async () => {
			mockIsActive.mockImplementation(() => false);

			await expect(
				handleSend({ action: 'send', surface: 'dead-session', text: 'hi' })
			).rejects.toThrow('Session not active');
		});

		it('passes behaviour parameter through', async () => {
			await handleSend({
				action: 'send',
				surface: 'sess-1',
				text: 'steer this',
			});

			await handleSend({
				action: 'send',
				surface: 'sess-1',
				key: 'enter',
				behavior: 'steer',
			});

			expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'steer this', 'steer');
		});
	});

	describe('handleRead', () => {
		it('returns output for a session', async () => {
			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
			});

			expect(result.ok).toBe(true);
			expect(result.surface).toBe('sess-1');
			expect(result.output).toContain('Hello from assistant');
			expect(result.isStreaming).toBe(false);
			expect(Array.isArray(result.lines)).toBe(true);
		});

		it('respects lines parameter', async () => {
			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
				lines: 5,
			});

			expect(result.ok).toBe(true);
			expect(result.lines.length).toBeLessThanOrEqual(5);
		});

		it('reports streaming state', async () => {
			mockGetStreamingState.mockImplementation(() => ({
				isStreaming: true,
				lastAgentStartTime: Date.now() as number | null,
			}));

			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
			});

			expect(result.isStreaming).toBe(true);
		});

		it('throws when surface is missing', async () => {
			await expect(
				handleRead({ action: 'read', surface: '' })
			).rejects.toThrow('Missing "surface"');
		});
	});

	describe('handleClose', () => {
		it('stops the session and cleans up', async () => {
			const result = await handleClose({
				action: 'close',
				surface: 'sess-1',
			});

			expect(result.ok).toBe(true);
			expect(result.surface).toBe('sess-1');
			expect(mockStopSession).toHaveBeenCalledWith('sess-1');
		});

		it('throws when surface is missing', async () => {
			await expect(
				handleClose({ action: 'close', surface: '' })
			).rejects.toThrow('Missing "surface"');
		});
	});

	describe('handleList', () => {
		it('returns all active sessions', async () => {
			const result = await handleList();

			expect(result.ok).toBe(true);
			expect(result.sessions).toHaveLength(2);
			expect(result.sessions[0].surface).toBe('sess-1');
			expect(result.sessions[1].surface).toBe('sess-2');
		});

		it('includes metadata for each session', async () => {
			const result = await handleList();

			expect(result.sessions[0].cwd).toBe('/tmp/test');
			expect(result.sessions[0].model).toBe('test-model');
			expect(result.sessions[0].isStreaming).toBe(false);
			expect(result.sessions[0].name).toBe('Test Session');
			expect(result.sessions[0].firstMessage).toBe('Hello');
		});
	});

	describe('handleNotify', () => {
		it('accepts a notification', async () => {
			const result = await handleNotify({
				action: 'notify',
				title: '✅ Done',
				body: 'PR approved',
			});

			expect(result.ok).toBe(true);
		});

		it('works without body', async () => {
			const result = await handleNotify({
				action: 'notify',
				title: 'Hello',
			});

			expect(result.ok).toBe(true);
		});

		it('throws when title is missing', async () => {
			await expect(
				handleNotify({ action: 'notify', title: '' })
			).rejects.toThrow('Missing "title"');
		});
	});

	describe('renderMessagesAsText (via handleRead)', () => {
		it('renders compaction messages', async () => {
			mockGetTailMessages.mockResolvedValueOnce({
				messages: [{ type: 'compaction', message: { role: 'system', content: [] } }],
				hasMore: false,
			});

			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
			});

			expect(result.output).toContain('[compacted]');
		});

		it('renders user messages with prefix', async () => {
			mockGetTailMessages.mockResolvedValueOnce({
				messages: [
					{
						type: 'message',
						message: {
							role: 'user',
							content: [{ type: 'text', text: 'What is the meaning of life?' }],
						},
					},
				],
				hasMore: false,
			});

			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
			});

			expect(result.output).toContain('> What is the meaning of life?');
		});

		it('renders tool use blocks', async () => {
			mockGetTailMessages.mockResolvedValueOnce({
				messages: [
					{
						type: 'message',
						message: {
							role: 'assistant',
							content: [
								{ type: 'text', text: 'Let me check that.' },
								{ type: 'tool_use', name: 'Read' },
							],
						},
					},
				],
				hasMore: false,
			});

			const result = await handleRead({
				action: 'read',
				surface: 'sess-1',
			});

			expect(result.output).toContain('Let me check that.');
			expect(result.output).toContain('[tool: Read]');
		});
	});
});
