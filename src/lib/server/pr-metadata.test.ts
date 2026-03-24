import { describe, it, expect } from 'bun:test';
import { parsePrUrl, fallbackTitle } from './pr-metadata';

describe('pr-metadata', () => {
	describe('parsePrUrl', () => {
		it('parses a standard GitHub PR URL', () => {
			const result = parsePrUrl('https://github.com/Urban-Climb/pump/pull/75');
			expect(result).toEqual({ owner: 'Urban-Climb', repo: 'pump', prNumber: 75 });
		});

		it('parses a URL with trailing slash', () => {
			const result = parsePrUrl('https://github.com/org/repo/pull/123/');
			expect(result).toEqual({ owner: 'org', repo: 'repo', prNumber: 123 });
		});

		it('handles whitespace around the URL', () => {
			const result = parsePrUrl('  https://github.com/foo/bar/pull/1  ');
			expect(result).toEqual({ owner: 'foo', repo: 'bar', prNumber: 1 });
		});

		it('returns null for non-GitHub URLs', () => {
			expect(parsePrUrl('https://gitlab.com/org/repo/merge_requests/1')).toBeNull();
		});

		it('returns null for GitHub URLs that are not PRs', () => {
			expect(parsePrUrl('https://github.com/org/repo/issues/42')).toBeNull();
		});

		it('returns null for GitHub PR URLs with extra path segments', () => {
			expect(parsePrUrl('https://github.com/org/repo/pull/42/files')).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(parsePrUrl('')).toBeNull();
		});

		it('returns null for garbage input', () => {
			expect(parsePrUrl('not a url at all')).toBeNull();
		});
	});

	describe('fallbackTitle', () => {
		it('returns PR number for a valid GitHub PR URL', () => {
			expect(fallbackTitle('https://github.com/org/repo/pull/99')).toBe('PR #99');
		});

		it('returns the raw URL when parsing fails', () => {
			const url = 'https://example.com/some/page';
			expect(fallbackTitle(url)).toBe(url);
		});
	});
});
