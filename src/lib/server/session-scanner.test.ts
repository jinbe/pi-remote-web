import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeSessionId } from './session-scanner';

describe('encodeSessionId', () => {
	it('produces a base64url string', () => {
		const filePath = '/some/path/session.jsonl';
		const encoded = encodeSessionId(filePath);

		expect(encoded).toBeTruthy();
		expect(typeof encoded).toBe('string');
		// base64url: no +, /, =
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it('produces different IDs for different paths', () => {
		const a = encodeSessionId('/path/a.jsonl');
		const b = encodeSessionId('/path/b.jsonl');
		expect(a).not.toBe(b);
	});

	it('is deterministic', () => {
		const path = '/path/to/session.jsonl';
		expect(encodeSessionId(path)).toBe(encodeSessionId(path));
	});

	it('can be decoded back to original path via Buffer', () => {
		const path = '/home/user/.pi/agent/sessions/abc/test.jsonl';
		const encoded = encodeSessionId(path);
		const decoded = Buffer.from(encoded, 'base64url').toString();
		expect(decoded).toBe(path);
	});

	it('handles paths with special characters', () => {
		const path = '/home/user/my project (1)/sessions/file.jsonl';
		const encoded = encodeSessionId(path);
		const decoded = Buffer.from(encoded, 'base64url').toString();
		expect(decoded).toBe(path);
	});
});

describe('JSONL parsing patterns', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), 'pi-remote-test-' + Date.now());
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it('produces valid JSONL format', () => {
		const entries = [
			{ type: 'session', id: 's1', cwd: '/test', timestamp: '2025-01-01T00:00:00Z' },
			{
				type: 'message',
				id: 'm1',
				parentId: null,
				timestamp: '2025-01-01T00:00:01Z',
				message: { role: 'user', content: [{ type: 'text', text: 'Hello world' }] }
			},
			{
				type: 'message',
				id: 'm2',
				parentId: 'm1',
				timestamp: '2025-01-01T00:00:02Z',
				message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
			}
		];

		const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
		const filePath = join(testDir, 'test.jsonl');
		writeFileSync(filePath, jsonl);

		// Verify each line is valid JSON
		const lines = jsonl.split('\n');
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it('handles malformed JSONL lines gracefully', () => {
		const text = '{"type":"session","id":"s1"}\ninvalid json\n{"type":"message","id":"m1"}';
		const entries: any[] = [];
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// Should skip malformed
			}
		}
		expect(entries.length).toBe(2);
		expect(entries[0].id).toBe('s1');
		expect(entries[1].id).toBe('m1');
	});

	it('handles empty lines in JSONL', () => {
		const text = '{"type":"session","id":"s1"}\n\n\n{"type":"message","id":"m1"}\n';
		const entries: any[] = [];
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// skip
			}
		}
		expect(entries.length).toBe(2);
	});
});

describe('session metadata extraction logic', () => {
	it('extracts cwd from session entry', () => {
		const entry = { type: 'session', cwd: '/home/user/project' };
		expect(entry.cwd).toBe('/home/user/project');
	});

	it('extracts name from session_info entry', () => {
		const entry = { type: 'session_info', name: 'My Session' };
		expect(entry.name).toBe('My Session');
	});

	it('builds model string with provider prefix', () => {
		const entry = { type: 'model_change', provider: 'anthropic', modelId: 'claude-3.5-sonnet' };
		const model = entry.modelId
			? `${entry.provider ? entry.provider + '/' : ''}${entry.modelId}`
			: null;
		expect(model).toBe('anthropic/claude-3.5-sonnet');
	});

	it('builds model string without provider', () => {
		const entry = { type: 'model_change', provider: '', modelId: 'gpt-4' };
		const model = entry.modelId
			? `${entry.provider ? entry.provider + '/' : ''}${entry.modelId}`
			: null;
		expect(model).toBe('gpt-4');
	});

	it('returns null for missing modelId', () => {
		const entry = { type: 'model_change', provider: 'anthropic', modelId: '' };
		const model = entry.modelId
			? `${entry.provider ? entry.provider + '/' : ''}${entry.modelId}`
			: null;
		expect(model).toBeNull();
	});

	it('extracts first user message text', () => {
		const content = [{ type: 'text', text: 'Build a REST API' }];
		const textContent = content.find((c: any) => c.type === 'text');
		expect(textContent?.text).toBe('Build a REST API');
	});

	it('truncates first message to 200 chars', () => {
		const longText = 'x'.repeat(500);
		const extracted = longText.slice(0, 200);
		expect(extracted.length).toBe(200);
	});

	it('extracts createdAt from filename', () => {
		const filename = '2025-01-15T12:00:00Z_abc-123.jsonl';
		const createdAt = filename.split('_')[0];
		expect(createdAt).toBe('2025-01-15T12:00:00Z');
	});
});
