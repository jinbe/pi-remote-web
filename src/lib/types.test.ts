import { describe, it, expect } from 'bun:test';
import type {
	JournalEntry,
	SessionMeta,
	SessionTree,
	BranchPoint,
	RpcSessionState,
	ExtensionUIRequest
} from './types';

// Type-level tests: verify our interfaces match expected shapes at compile+runtime.

describe('type shapes', () => {
	it('JournalEntry has required fields', () => {
		const entry: JournalEntry = {
			type: 'message',
			id: 'test-id',
			timestamp: '2025-01-01T00:00:00Z'
		};
		expect(entry.type).toBe('message');
		expect(entry.id).toBe('test-id');
	});

	it('JournalEntry message field accepts all roles', () => {
		const roles: Array<'user' | 'assistant' | 'toolResult'> = ['user', 'assistant', 'toolResult'];
		for (const role of roles) {
			const entry: JournalEntry = {
				type: 'message',
				id: `msg-${role}`,
				timestamp: '2025-01-01T00:00:00Z',
				message: { role, content: [] }
			};
			expect(entry.message!.role).toBe(role);
		}
	});

	it('JournalEntry supports optional usage/cost fields', () => {
		const entry: JournalEntry = {
			type: 'message',
			id: 'msg-usage',
			timestamp: '2025-01-01T00:00:00Z',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'hello' }],
				model: 'claude-3.5-sonnet',
				usage: { input: 100, output: 50, cost: { total: 0.01 } },
				stopReason: 'end_turn'
			}
		};
		expect(entry.message!.usage!.input).toBe(100);
		expect(entry.message!.usage!.cost!.total).toBe(0.01);
	});

	it('SessionMeta has all required fields', () => {
		const meta: SessionMeta = {
			id: 'test',
			filePath: '/path/to/file.jsonl',
			cwd: '/project',
			name: 'Test Session',
			firstMessage: 'Hello',
			lastModified: new Date(),
			messageCount: 5,
			model: 'anthropic/claude-3.5-sonnet'
		};
		expect(meta.id).toBeTruthy();
		expect(meta.filePath).toBeTruthy();
		expect(meta.messageCount).toBe(5);
	});

	it('SessionTree has correct structure', () => {
		const tree: SessionTree = {
			nodes: {},
			children: {},
			roots: [],
			leaves: [],
			currentLeaf: ''
		};
		expect(tree.roots).toEqual([]);
		expect(tree.leaves).toEqual([]);
		expect(tree.currentLeaf).toBe('');
	});

	it('BranchPoint contains branches array', () => {
		const bp: BranchPoint = {
			nodeId: 'n1',
			message: 'test',
			branches: [
				{
					childId: 'c1',
					preview: 'preview text',
					messageCount: 3,
					isCurrentPath: true
				}
			]
		};
		expect(bp.branches.length).toBe(1);
		expect(bp.branches[0].isCurrentPath).toBe(true);
	});

	it('RpcSessionState accepts null model', () => {
		const state: RpcSessionState = {
			model: null,
			thinkingLevel: 'medium',
			isStreaming: false,
			isCompacting: false,
			sessionFile: '/path/file.jsonl',
			sessionId: 'test-id',
			messageCount: 0,
			pendingMessageCount: 0
		};
		expect(state.model).toBeNull();
		expect(state.isStreaming).toBe(false);
	});

	it('RpcSessionState accepts model object', () => {
		const state: RpcSessionState = {
			model: { id: 'claude-3.5', name: 'Claude 3.5', provider: 'anthropic' },
			thinkingLevel: 'high',
			isStreaming: true,
			isCompacting: false,
			sessionFile: '/path/file.jsonl',
			sessionId: 'test-id',
			messageCount: 10,
			pendingMessageCount: 2
		};
		expect(state.model!.id).toBe('claude-3.5');
		expect(state.model!.provider).toBe('anthropic');
	});

	it('ExtensionUIRequest has flexible extra fields', () => {
		const req: ExtensionUIRequest = {
			type: 'extension_ui_request',
			id: 'req-1',
			method: 'input',
			title: 'Enter value',
			customField: 'allowed by index signature'
		};
		expect(req.method).toBe('input');
		expect(req['customField']).toBe('allowed by index signature');
	});

	it('ExtensionUIRequest supports all methods', () => {
		const methods = ['input', 'confirm', 'select', 'editor', 'notify', 'setStatus', 'setWidget', 'setTitle'];
		for (const method of methods) {
			const req: ExtensionUIRequest = {
				type: 'extension_ui_request',
				id: `req-${method}`,
				method
			};
			expect(req.method).toBe(method);
		}
	});
});
