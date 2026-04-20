import { json } from '@sveltejs/kit';
import { execSync, execFileSync } from 'child_process';
import type { RequestHandler } from './$types';

// Aliases first (most common), then full IDs. Users can also type any custom
// model string — the autocomplete falls back to the input value.
const DEFAULT_CLAUDE_CODE_MODELS = [
	'sonnet',
	'opus',
	'haiku',
	'claude-opus-4-7',
	'claude-sonnet-4-6',
	'claude-haiku-4-5',
	'claude-opus-4-5',
	'claude-sonnet-4-5',
];

const PI_MODEL_CACHE = new Map<string, { models: string[]; timestamp: number }>();
const CLAUDE_MODEL_CACHE = new Map<string, { models: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

export const GET: RequestHandler = async ({ url }) => {
	const harness = url.searchParams.get('harness') ?? 'pi';

	// Check cache for pi models
	if (harness === 'pi') {
		const cached = PI_MODEL_CACHE.get('pi');
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			return json({ models: cached.models, source: 'cache' });
		}
	}

	if (harness === 'claude-code' || harness === 'claude') {
		const cached = CLAUDE_MODEL_CACHE.get('claude');
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			return json({ models: cached.models, source: 'cache' });
		}
	}

	let models: string[];
	let source: 'pi' | 'fallback' | 'claude';

	if (harness === 'pi') {
		try {
			// Try to get models from pi harness
			const output = execSync('pi --list-models', {
				encoding: 'utf8' as const,
				timeout: 5000,
			});

			// Remove BOM if present
			const cleanedOutput = output.replace(/^\uFEFF/, '');

			// Parse output - first line is header, remaining lines are whitespace-delimited
			// Take columns 0 and 1, join with '/'
			const lines = cleanedOutput.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
			models = lines.map((line) => {
				const cols = line.split(/\s+/);
				return [cols[0], cols[1]].filter(Boolean).join('/');
			});
			source = 'pi';

			// Cache the result
			PI_MODEL_CACHE.set('pi', { models, timestamp: Date.now() });
		} catch (err) {
			console.warn('[models] pi --list-models failed:', err);
			// Fallback to common pi models
			models = [
				'anthropic/claude-sonnet-4',
				'anthropic/claude-opus-4',
				'anthropic/claude-sonnet-3-5',
				'anthropic/claude-opus-3',
				'anthropic/claude-sonnet-3',
			];
			source = 'fallback';
		}
	} else {
		// Claude Code harness — Claude has no `--list-models` flag, so we ship a
		// curated default list. We try to surface the user's configured default
		// model first via `claude config get model` (best-effort).
		models = DEFAULT_CLAUDE_CODE_MODELS.slice();
		source = 'fallback';
		try {
			const claudeBin = process.env.CLAUDE_BIN || 'claude';
			// execFileSync (no shell): args are passed as a literal array — no injection surface
			const out = execFileSync(claudeBin, ['config', 'get', 'model'], {
				encoding: 'utf8' as const,
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			const configured = out.trim();
			if (configured && /^[A-Za-z0-9._-]+$/.test(configured) && !models.includes(configured)) {
				models.unshift(configured);
				source = 'claude';
			}
		} catch {
			// best effort — claude not installed, no config, etc.
		}
		CLAUDE_MODEL_CACHE.set('claude', { models, timestamp: Date.now() });
	}

	return json({ models, source });
};