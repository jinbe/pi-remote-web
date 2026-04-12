import { json } from '@sveltejs/kit';
import { execSync } from 'child_process';
import type { RequestHandler } from './$types';

const DEFAULT_CLAUDE_CODE_MODELS = [
	'sonnet',
	'opus',
	'haiku',
];

const PI_MODEL_CACHE = new Map<string, { models: string[]; timestamp: number }>();
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

	let models: string[];
	let source: 'pi' | 'fallback';

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
		// Claude Code harness - use standard models
		models = DEFAULT_CLAUDE_CODE_MODELS.map((m) => `${m}`);
		source = 'fallback';
	}

	return json({ models, source });
};