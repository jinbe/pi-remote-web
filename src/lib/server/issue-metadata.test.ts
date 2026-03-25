import { describe, it, expect } from 'bun:test';
import { parseIssueUrl, parseLinearUrl, fallbackIssueTitle } from './issue-metadata';

describe('issue-metadata', () => {
	describe('parseIssueUrl', () => {
		it('parses a standard GitHub issue URL', () => {
			const result = parseIssueUrl('https://github.com/Urban-Climb/pump/issues/42');
			expect(result).toEqual({ provider: 'github', owner: 'Urban-Climb', repo: 'pump', issueNumber: 42 });
		});

		it('parses a URL with trailing slash', () => {
			const result = parseIssueUrl('https://github.com/org/repo/issues/123/');
			expect(result).toEqual({ provider: 'github', owner: 'org', repo: 'repo', issueNumber: 123 });
		});

		it('handles whitespace around the URL', () => {
			const result = parseIssueUrl('  https://github.com/foo/bar/issues/1  ');
			expect(result).toEqual({ provider: 'github', owner: 'foo', repo: 'bar', issueNumber: 1 });
		});

		it('returns null for non-GitHub URLs', () => {
			expect(parseIssueUrl('https://gitlab.com/org/repo/issues/1')).toBeNull();
		});

		it('returns null for GitHub PR URLs', () => {
			expect(parseIssueUrl('https://github.com/org/repo/pull/42')).toBeNull();
		});

		it('returns null for GitHub issue URLs with extra path segments', () => {
			expect(parseIssueUrl('https://github.com/org/repo/issues/42/comments')).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(parseIssueUrl('')).toBeNull();
		});

		it('returns null for garbage input', () => {
			expect(parseIssueUrl('not a url at all')).toBeNull();
		});
	});

	describe('parseLinearUrl', () => {
		it('parses a standard Linear issue URL', () => {
			const result = parseLinearUrl('https://linear.app/my-team/issue/ABC-123/add-user-auth');
			expect(result).toEqual({ provider: 'linear', team: 'my-team', id: 'ABC-123', slug: 'add-user-auth' });
		});

		it('parses a URL with trailing slash', () => {
			const result = parseLinearUrl('https://linear.app/team/issue/XY-1/some-slug/');
			expect(result).toEqual({ provider: 'linear', team: 'team', id: 'XY-1', slug: 'some-slug' });
		});

		it('handles whitespace around the URL', () => {
			const result = parseLinearUrl('  https://linear.app/t/issue/ID-99/fix-bug  ');
			expect(result).toEqual({ provider: 'linear', team: 't', id: 'ID-99', slug: 'fix-bug' });
		});

		it('returns null for non-Linear URLs', () => {
			expect(parseLinearUrl('https://github.com/org/repo/issues/1')).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(parseLinearUrl('')).toBeNull();
		});
	});

	describe('fallbackIssueTitle', () => {
		it('returns issue number for a valid GitHub issue URL', () => {
			expect(fallbackIssueTitle('https://github.com/org/repo/issues/99')).toBe('Issue #99');
		});

		it('returns slug for a valid Linear issue URL', () => {
			expect(fallbackIssueTitle('https://linear.app/team/issue/ABC-1/add-user-auth')).toBe('add user auth');
		});

		it('returns the raw URL when parsing fails', () => {
			const url = 'https://example.com/some/page';
			expect(fallbackIssueTitle(url)).toBe(url);
		});
	});
});
