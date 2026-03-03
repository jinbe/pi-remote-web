// Pure utility functions for formatting tool calls in the chat UI.
// Extracted from ChatBubble.svelte for testability.

export interface DiffLine {
	type: 'ctx' | 'del' | 'add';
	text: string;
}

export function getArgs(tc: { arguments?: string | Record<string, any> }): Record<string, any> {
	if (!tc.arguments) return {};
	if (typeof tc.arguments === 'string') {
		try { return JSON.parse(tc.arguments); } catch { return {}; }
	}
	return tc.arguments;
}

export function shortPath(p: string): string {
	if (!p) return '';
	const parts = p.split('/');
	if (parts.length <= 3) return p;
	return '…/' + parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + '…';
}

/** Short summary shown next to the tool icon in the collapsed state */
export function toolSummary(tc: { name?: string; arguments?: any }): string {
	const args = getArgs(tc);
	const name = (tc.name || '').toLowerCase();
	if (name === 'bash') {
		const cmd = args.command || '';
		const firstLine = cmd.split('\n')[0];
		return truncate(firstLine, 60);
	}
	if (name === 'read') {
		let s = shortPath(args.path || '');
		if (args.offset) s += `:${args.offset}`;
		if (args.limit) s += `+${args.limit}`;
		return s;
	}
	if (name === 'edit') {
		return shortPath(args.path || '');
	}
	if (name === 'write') {
		return shortPath(args.path || '');
	}
	if (name === 'lsp') {
		let s = args.action || '';
		if (args.query) s += ` ${args.query}`;
		if (args.file) s += ` ${shortPath(args.file)}`;
		return s;
	}
	return '';
}

/** Build a simple unified-diff style view from oldText → newText using LCS */
export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');

	const m = oldLines.length;
	const n = newLines.length;

	// For very large texts, fall back to simple before/after
	if (m + n > 200) {
		const result: DiffLine[] = [];
		for (const l of oldLines) result.push({ type: 'del', text: l });
		for (const l of newLines) result.push({ type: 'add', text: l });
		return result;
	}

	// Build LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to build diff
	const raw: DiffLine[] = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			raw.unshift({ type: 'ctx', text: oldLines[i - 1] });
			i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			raw.unshift({ type: 'add', text: newLines[j - 1] });
			j--;
		} else {
			raw.unshift({ type: 'del', text: oldLines[i - 1] });
			i--;
		}
	}

	return raw;
}
