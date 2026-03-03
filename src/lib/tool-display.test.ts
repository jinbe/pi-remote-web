import { describe, it, expect } from 'bun:test';
import { getArgs, shortPath, toolSummary, buildDiffLines } from './tool-display';

// --- getArgs ---

describe('getArgs', () => {
	it('returns empty object for missing arguments', () => {
		expect(getArgs({})).toEqual({});
		expect(getArgs({ arguments: undefined })).toEqual({});
		expect(getArgs({ arguments: null as any })).toEqual({});
	});

	it('returns object arguments as-is', () => {
		const args = { command: 'ls', timeout: 10 };
		expect(getArgs({ arguments: args })).toBe(args);
	});

	it('parses JSON string arguments', () => {
		expect(getArgs({ arguments: '{"path":"/tmp/foo"}' })).toEqual({ path: '/tmp/foo' });
	});

	it('returns empty object for invalid JSON string', () => {
		expect(getArgs({ arguments: 'not json' })).toEqual({});
	});

	it('returns empty object for empty string', () => {
		expect(getArgs({ arguments: '' })).toEqual({});
	});
});

// --- shortPath ---

describe('shortPath', () => {
	it('returns empty string for empty input', () => {
		expect(shortPath('')).toBe('');
	});

	it('returns short paths as-is', () => {
		expect(shortPath('foo.ts')).toBe('foo.ts');
		expect(shortPath('src/foo.ts')).toBe('src/foo.ts');
		expect(shortPath('/src/foo.ts')).toBe('/src/foo.ts');
	});

	it('truncates paths with more than 3 segments', () => {
		expect(shortPath('/Users/jchan/code/project/src/lib/utils.ts')).toBe('…/lib/utils.ts');
	});

	it('keeps last two segments', () => {
		expect(shortPath('a/b/c/d')).toBe('…/c/d');
		expect(shortPath('/a/b/c/d/e')).toBe('…/d/e');
	});
});

// --- toolSummary ---

describe('toolSummary', () => {
	it('returns empty string for unknown tools', () => {
		expect(toolSummary({ name: 'unknown', arguments: {} })).toBe('');
	});

	it('returns empty string when name is missing', () => {
		expect(toolSummary({})).toBe('');
	});

	describe('Bash', () => {
		it('shows first line of command', () => {
			expect(toolSummary({ name: 'Bash', arguments: { command: 'ls -la' } })).toBe('ls -la');
		});

		it('shows only first line for multiline commands', () => {
			expect(toolSummary({ name: 'Bash', arguments: { command: 'cd /tmp\nls -la' } })).toBe('cd /tmp');
		});

		it('truncates long commands to 60 chars', () => {
			const long = 'a'.repeat(100);
			const result = toolSummary({ name: 'Bash', arguments: { command: long } });
			expect(result.length).toBe(61); // 60 + '…'
			expect(result.endsWith('…')).toBe(true);
		});

		it('handles missing command', () => {
			expect(toolSummary({ name: 'Bash', arguments: {} })).toBe('');
		});

		it('is case-insensitive on tool name', () => {
			expect(toolSummary({ name: 'bash', arguments: { command: 'echo hi' } })).toBe('echo hi');
		});
	});

	describe('Read', () => {
		it('shows short path', () => {
			expect(toolSummary({ name: 'Read', arguments: { path: '/a/b/c/d/e.ts' } })).toBe('…/d/e.ts');
		});

		it('appends offset', () => {
			expect(toolSummary({ name: 'Read', arguments: { path: 'foo.ts', offset: 10 } })).toBe('foo.ts:10');
		});

		it('appends limit', () => {
			expect(toolSummary({ name: 'Read', arguments: { path: 'foo.ts', limit: 50 } })).toBe('foo.ts+50');
		});

		it('appends offset and limit', () => {
			expect(toolSummary({ name: 'Read', arguments: { path: 'foo.ts', offset: 10, limit: 50 } })).toBe('foo.ts:10+50');
		});
	});

	describe('Edit', () => {
		it('shows short path', () => {
			expect(toolSummary({ name: 'Edit', arguments: { path: '/a/b/c/d.ts', oldText: 'x', newText: 'y' } })).toBe('…/c/d.ts');
		});
	});

	describe('Write', () => {
		it('shows short path', () => {
			expect(toolSummary({ name: 'Write', arguments: { path: 'src/foo.ts', content: 'hello' } })).toBe('src/foo.ts');
		});
	});

	describe('lsp', () => {
		it('shows action', () => {
			expect(toolSummary({ name: 'lsp', arguments: { action: 'definition' } })).toBe('definition');
		});

		it('shows action with query', () => {
			expect(toolSummary({ name: 'lsp', arguments: { action: 'references', query: 'foo' } })).toBe('references foo');
		});

		it('shows action with file', () => {
			expect(toolSummary({ name: 'lsp', arguments: { action: 'diagnostics', file: '/a/b/c/d.ts' } })).toBe('diagnostics …/c/d.ts');
		});

		it('shows action with query and file', () => {
			expect(toolSummary({ name: 'lsp', arguments: { action: 'hover', query: 'bar', file: 'src/x.ts' } })).toBe('hover bar src/x.ts');
		});
	});

	describe('string arguments', () => {
		it('parses JSON string arguments', () => {
			expect(toolSummary({ name: 'Bash', arguments: '{"command":"echo hello"}' })).toBe('echo hello');
		});
	});
});

// --- buildDiffLines ---

describe('buildDiffLines', () => {
	it('returns empty context for identical single-line text', () => {
		const result = buildDiffLines('hello', 'hello');
		expect(result).toEqual([{ type: 'ctx', text: 'hello' }]);
	});

	it('shows pure addition when old is empty', () => {
		const result = buildDiffLines('', 'new line');
		expect(result).toEqual([
			{ type: 'del', text: '' },
			{ type: 'add', text: 'new line' }
		]);
	});

	it('shows pure deletion when new is empty', () => {
		const result = buildDiffLines('old line', '');
		expect(result).toEqual([
			{ type: 'del', text: 'old line' },
			{ type: 'add', text: '' }
		]);
	});

	it('shows a simple single-line replacement', () => {
		const result = buildDiffLines('old', 'new');
		expect(result).toEqual([
			{ type: 'del', text: 'old' },
			{ type: 'add', text: 'new' }
		]);
	});

	it('handles multiline with context', () => {
		const old = 'line1\nline2\nline3';
		const new_ = 'line1\nchanged\nline3';
		const result = buildDiffLines(old, new_);
		expect(result).toEqual([
			{ type: 'ctx', text: 'line1' },
			{ type: 'del', text: 'line2' },
			{ type: 'add', text: 'changed' },
			{ type: 'ctx', text: 'line3' }
		]);
	});

	it('handles added lines', () => {
		const old = 'a\nc';
		const new_ = 'a\nb\nc';
		const result = buildDiffLines(old, new_);
		expect(result).toEqual([
			{ type: 'ctx', text: 'a' },
			{ type: 'add', text: 'b' },
			{ type: 'ctx', text: 'c' }
		]);
	});

	it('handles removed lines', () => {
		const old = 'a\nb\nc';
		const new_ = 'a\nc';
		const result = buildDiffLines(old, new_);
		expect(result).toEqual([
			{ type: 'ctx', text: 'a' },
			{ type: 'del', text: 'b' },
			{ type: 'ctx', text: 'c' }
		]);
	});

	it('handles complete replacement', () => {
		const old = 'aaa\nbbb';
		const new_ = 'xxx\nyyy';
		const result = buildDiffLines(old, new_);
		const types = result.map(r => r.type);
		expect(types).not.toContain('ctx');
		expect(result.filter(r => r.type === 'del').map(r => r.text)).toEqual(['aaa', 'bbb']);
		expect(result.filter(r => r.type === 'add').map(r => r.text)).toEqual(['xxx', 'yyy']);
	});

	it('falls back to simple del/add for large texts (>200 lines total)', () => {
		const oldLines = Array.from({ length: 101 }, (_, i) => `old${i}`);
		const newLines = Array.from({ length: 101 }, (_, i) => `new${i}`);
		const result = buildDiffLines(oldLines.join('\n'), newLines.join('\n'));
		// Should be all del then all add (no LCS)
		expect(result.filter(r => r.type === 'del')).toHaveLength(101);
		expect(result.filter(r => r.type === 'add')).toHaveLength(101);
		expect(result.filter(r => r.type === 'ctx')).toHaveLength(0);
		// Dels should come first
		const firstAdd = result.findIndex(r => r.type === 'add');
		const lastDel = result.findLastIndex(r => r.type === 'del');
		expect(lastDel).toBeLessThan(firstAdd);
	});

	it('handles both empty strings', () => {
		const result = buildDiffLines('', '');
		expect(result).toEqual([{ type: 'ctx', text: '' }]);
	});

	it('handles trailing newlines correctly', () => {
		const old = 'a\nb\n';
		const new_ = 'a\nb\nc\n';
		const result = buildDiffLines(old, new_);
		expect(result.filter(r => r.type === 'add').map(r => r.text)).toEqual(['c']);
		expect(result.filter(r => r.type === 'ctx')).toHaveLength(3); // 'a', 'b', ''
	});
});
