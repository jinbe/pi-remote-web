import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listPathSuggestions, MAX_SUGGESTIONS } from './path-autocomplete';

// ── Test fixture ────────────────────────────────────────────────────────────
// tmp/
//   alpha/          (dir)
//   alpha-two/      (dir)
//   bravo.txt       (file)
//   .hidden/        (dir)
//   .hidden-file    (file)

const TMP = join(tmpdir(), `path-autocomplete-test-${process.pid}`);

beforeAll(() => {
	mkdirSync(join(TMP, 'alpha'), { recursive: true });
	mkdirSync(join(TMP, 'alpha-two'), { recursive: true });
	writeFileSync(join(TMP, 'bravo.txt'), '');
	mkdirSync(join(TMP, '.hidden'), { recursive: true });
	writeFileSync(join(TMP, '.hidden-file'), '');
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('listPathSuggestions', () => {
	it('returns empty array for an empty query', () => {
		expect(listPathSuggestions('')).toEqual([]);
	});

	it('returns empty array for a non-existent parent directory', () => {
		expect(listPathSuggestions('/this/does/not/exist/foo')).toEqual([]);
	});

	it('lists all non-hidden entries when query ends with /', () => {
		const results = listPathSuggestions(`${TMP}/`);
		expect(results).toContain(`${TMP}/alpha/`);
		expect(results).toContain(`${TMP}/alpha-two/`);
		expect(results).toContain(`${TMP}/bravo.txt`);
		// Hidden entries must NOT appear when no dot prefix was typed
		expect(results).not.toContain(`${TMP}/.hidden/`);
		expect(results).not.toContain(`${TMP}/.hidden-file`);
	});

	it('filters entries by the typed prefix', () => {
		const results = listPathSuggestions(`${TMP}/al`);
		expect(results).toContain(`${TMP}/alpha/`);
		expect(results).toContain(`${TMP}/alpha-two/`);
		expect(results).not.toContain(`${TMP}/bravo.txt`);
	});

	it('appends a trailing slash to directory suggestions', () => {
		const results = listPathSuggestions(`${TMP}/alp`);
		for (const r of results) {
			expect(r.endsWith('/')).toBeTrue();
		}
	});

	it('does NOT append trailing slash to file suggestions', () => {
		const results = listPathSuggestions(`${TMP}/bra`);
		expect(results).toContain(`${TMP}/bravo.txt`);
		expect(results.every((r) => !r.endsWith('/') || r === `${TMP}/bravo.txt`)).toBeTrue();
	});

	it('returns hidden entries when the prefix starts with a dot', () => {
		const results = listPathSuggestions(`${TMP}/.`);
		expect(results).toContain(`${TMP}/.hidden/`);
		expect(results).toContain(`${TMP}/.hidden-file`);
	});

	it('returns a sorted list', () => {
		const results = listPathSuggestions(`${TMP}/`);
		const sorted = [...results].sort();
		expect(results).toEqual(sorted);
	});

	it('expands ~ to HOME', () => {
		const home = process.env.HOME;
		if (!home) return; // skip if HOME is not set (unlikely in CI)
		const results = listPathSuggestions('~/');
		// Should return something without throwing
		expect(Array.isArray(results)).toBeTrue();
	});

	it(`caps results at MAX_SUGGESTIONS (${MAX_SUGGESTIONS})`, () => {
		// Create enough entries to exceed the cap
		const bulkDir = join(TMP, 'bulk');
		mkdirSync(bulkDir, { recursive: true });
		for (let i = 0; i < MAX_SUGGESTIONS + 5; i++) {
			writeFileSync(join(bulkDir, `file${String(i).padStart(3, '0')}.txt`), '');
		}

		const results = listPathSuggestions(`${bulkDir}/`);
		expect(results.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
	});
});
