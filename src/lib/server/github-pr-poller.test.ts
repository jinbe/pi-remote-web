import { describe, it, expect, afterEach } from 'bun:test';
import {
	getMonitoredRepos,
	getMonitoredRepo,
	createMonitoredRepo,
	updateMonitoredRepo,
	deleteMonitoredRepo,
	start,
	stop,
	isRunning,
	_resetForTesting,
	getPollIntervalMs,
	getConcurrency,
	getPrMaxAgeDays,
	getPrReviewState,
	upsertPrReviewState,
	getGitHubUser,
	listOpenPrs,
	scanRepos,
	scanAllRepos,
} from './github-pr-poller';
import { getDb } from './cache';

/** IDs of repos created during the current test for cleanup. */
let testRepoIds: string[] = [];

function createTestRepo(input: Parameters<typeof createMonitoredRepo>[0]) {
	const repo = createMonitoredRepo(input);
	testRepoIds.push(repo.id);
	return repo;
}

function cleanupTestRepos() {
	const db = getDb();
	for (const id of testRepoIds) {
		db.run('DELETE FROM monitored_repos WHERE id = ?', [id]);
	}
	testRepoIds = [];
}

describe('github-pr-poller', () => {
	afterEach(() => {
		stop();
		_resetForTesting();
		cleanupTestRepos();
	});

	describe('async GitHub CLI helpers', () => {
		it('getGitHubUser returns a promise', () => {
			const result = getGitHubUser();
			expect(result).toBeInstanceOf(Promise);
		});

		it('getGitHubUser resolves to a string or null', async () => {
			const user = await getGitHubUser();
			// In CI or without gh auth, this may be null; with auth it's a string
			if (user !== null) {
				expect(typeof user).toBe('string');
				expect(user.length).toBeGreaterThan(0);
			} else {
				expect(user).toBeNull();
			}
		});

		it('listOpenPrs returns a promise', () => {
			const result = listOpenPrs('nonexistent-owner-xyz', 'nonexistent-repo-xyz');
			expect(result).toBeInstanceOf(Promise);
		});

		it('listOpenPrs resolves to an array (empty for non-existent repo)', async () => {
			const prs = await listOpenPrs('nonexistent-owner-xyz', 'nonexistent-repo-xyz');
			expect(Array.isArray(prs)).toBe(true);
			expect(prs).toHaveLength(0);
		});

		it('scanRepos is async and returns result object', async () => {
			// With no repos configured for auto-polling, should return zeros
			const result = await scanRepos();
			expect(result).toHaveProperty('created');
			expect(result).toHaveProperty('skipped');
			expect(result).toHaveProperty('errors');
			expect(typeof result.created).toBe('number');
			expect(typeof result.skipped).toBe('number');
			expect(typeof result.errors).toBe('number');
		});

		it('scanAllRepos is async and returns result object', async () => {
			const result = await scanAllRepos();
			expect(result).toHaveProperty('created');
			expect(result).toHaveProperty('skipped');
			expect(result).toHaveProperty('errors');
		});
	});

	describe('repo CRUD', () => {
		it('creates a monitored repo with defaults', () => {
			const repo = createTestRepo({ owner: 'acme', name: 'widget' });

			expect(repo.id).toBeTruthy();
			expect(repo.owner).toBe('acme');
			expect(repo.name).toBe('widget');
			expect(repo.local_path).toBeNull();
			expect(repo.assigned_only).toBe(1);
			expect(repo.manual_only).toBe(1);
			expect(repo.enabled).toBe(1);
		});

		it('creates a repo with custom toggles', () => {
			const repo = createTestRepo({
				owner: 'acme',
				name: 'gadget',
				local_path: '/code/gadget',
				assigned_only: false,
				manual_only: false,
				enabled: true,
			});

			expect(repo.local_path).toBe('/code/gadget');
			expect(repo.assigned_only).toBe(0);
			expect(repo.manual_only).toBe(0);
			expect(repo.enabled).toBe(1);
		});

		it('enforces unique constraint on owner/name', () => {
			createTestRepo({ owner: 'acme', name: 'dupe' });
			expect(() => createTestRepo({ owner: 'acme', name: 'dupe' })).toThrow();
		});

		it('lists all monitored repos', () => {
			createTestRepo({ owner: 'acme', name: 'alpha' });
			createTestRepo({ owner: 'acme', name: 'bravo' });

			const repos = getMonitoredRepos();
			const testRepos = repos.filter(r => testRepoIds.includes(r.id));
			expect(testRepos).toHaveLength(2);
		});

		it('gets a single repo by ID', () => {
			const created = createTestRepo({ owner: 'acme', name: 'find-me' });
			const found = getMonitoredRepo(created.id);

			expect(found).not.toBeNull();
			expect(found!.name).toBe('find-me');
		});

		it('returns null for non-existent repo ID', () => {
			expect(getMonitoredRepo('nonexistent')).toBeNull();
		});

		it('updates toggles', () => {
			const repo = createTestRepo({ owner: 'acme', name: 'toggle-test' });

			const updated = updateMonitoredRepo(repo.id, {
				assigned_only: false,
				manual_only: false,
				enabled: false,
			});

			expect(updated!.assigned_only).toBe(0);
			expect(updated!.manual_only).toBe(0);
			expect(updated!.enabled).toBe(0);
		});

		it('updates local_path', () => {
			const repo = createTestRepo({ owner: 'acme', name: 'path-test' });

			const updated = updateMonitoredRepo(repo.id, { local_path: '/new/path' });
			expect(updated!.local_path).toBe('/new/path');

			const cleared = updateMonitoredRepo(repo.id, { local_path: null });
			expect(cleared!.local_path).toBeNull();
		});

		it('returns null when updating non-existent repo', () => {
			expect(updateMonitoredRepo('nonexistent', { enabled: false })).toBeNull();
		});

		it('deletes a repo', () => {
			const repo = createTestRepo({ owner: 'acme', name: 'delete-me' });
			const deleted = deleteMonitoredRepo(repo.id);

			expect(deleted).not.toBeNull();
			expect(deleted!.name).toBe('delete-me');
			expect(getMonitoredRepo(repo.id)).toBeNull();
		});

		it('returns null when deleting non-existent repo', () => {
			expect(deleteMonitoredRepo('nonexistent')).toBeNull();
		});
	});

	describe('start/stop', () => {
		it('starts and reports running', () => {
			expect(isRunning()).toBe(false);
			start();
			expect(isRunning()).toBe(true);
		});

		it('stops and reports not running', () => {
			start();
			stop();
			expect(isRunning()).toBe(false);
		});

		it('is idempotent — starting twice does not error', () => {
			start();
			start();
			expect(isRunning()).toBe(true);
		});

		it('is idempotent — stopping when not running does not error', () => {
			stop();
			expect(isRunning()).toBe(false);
		});
	});

	describe('configuration', () => {
		it('returns default poll interval when env is unset', () => {
			const original = process.env.PI_PR_POLL_INTERVAL_SECONDS;
			delete process.env.PI_PR_POLL_INTERVAL_SECONDS;

			expect(getPollIntervalMs()).toBe(600_000); // 10 minutes

			if (original !== undefined) process.env.PI_PR_POLL_INTERVAL_SECONDS = original;
		});

		it('reads poll interval from env', () => {
			const original = process.env.PI_PR_POLL_INTERVAL_SECONDS;
			process.env.PI_PR_POLL_INTERVAL_SECONDS = '120';

			expect(getPollIntervalMs()).toBe(120_000);

			if (original !== undefined) {
				process.env.PI_PR_POLL_INTERVAL_SECONDS = original;
			} else {
				delete process.env.PI_PR_POLL_INTERVAL_SECONDS;
			}
		});

		it('falls back to default for invalid poll interval', () => {
			const original = process.env.PI_PR_POLL_INTERVAL_SECONDS;
			process.env.PI_PR_POLL_INTERVAL_SECONDS = 'not-a-number';

			expect(getPollIntervalMs()).toBe(600_000);

			if (original !== undefined) {
				process.env.PI_PR_POLL_INTERVAL_SECONDS = original;
			} else {
				delete process.env.PI_PR_POLL_INTERVAL_SECONDS;
			}
		});

		it('returns default concurrency when env is unset', () => {
			const original = process.env.PI_PR_POLL_CONCURRENCY;
			delete process.env.PI_PR_POLL_CONCURRENCY;

			expect(getConcurrency()).toBe(5);

			if (original !== undefined) process.env.PI_PR_POLL_CONCURRENCY = original;
		});

		it('reads concurrency from env', () => {
			const original = process.env.PI_PR_POLL_CONCURRENCY;
			process.env.PI_PR_POLL_CONCURRENCY = '10';

			expect(getConcurrency()).toBe(10);

			if (original !== undefined) {
				process.env.PI_PR_POLL_CONCURRENCY = original;
			} else {
				delete process.env.PI_PR_POLL_CONCURRENCY;
			}
		});

		it('returns default PR max age (30 days) when env is unset', () => {
			const original = process.env.PI_PR_MAX_AGE_DAYS;
			delete process.env.PI_PR_MAX_AGE_DAYS;

			expect(getPrMaxAgeDays()).toBe(30);

			if (original !== undefined) process.env.PI_PR_MAX_AGE_DAYS = original;
		});

		it('reads PR max age from env', () => {
			const original = process.env.PI_PR_MAX_AGE_DAYS;
			process.env.PI_PR_MAX_AGE_DAYS = '7';

			expect(getPrMaxAgeDays()).toBe(7);

			if (original !== undefined) {
				process.env.PI_PR_MAX_AGE_DAYS = original;
			} else {
				delete process.env.PI_PR_MAX_AGE_DAYS;
			}
		});

		it('falls back to default for invalid PR max age', () => {
			const original = process.env.PI_PR_MAX_AGE_DAYS;
			process.env.PI_PR_MAX_AGE_DAYS = 'not-a-number';

			expect(getPrMaxAgeDays()).toBe(30);

			if (original !== undefined) {
				process.env.PI_PR_MAX_AGE_DAYS = original;
			} else {
				delete process.env.PI_PR_MAX_AGE_DAYS;
			}
		});

		it('rejects zero or negative PR max age', () => {
			const original = process.env.PI_PR_MAX_AGE_DAYS;
			process.env.PI_PR_MAX_AGE_DAYS = '0';
			expect(getPrMaxAgeDays()).toBe(30);
			process.env.PI_PR_MAX_AGE_DAYS = '-5';
			expect(getPrMaxAgeDays()).toBe(30);

			if (original !== undefined) {
				process.env.PI_PR_MAX_AGE_DAYS = original;
			} else {
				delete process.env.PI_PR_MAX_AGE_DAYS;
			}
		});
	});

	describe('pr review state persistence', () => {
		const TEST_PR_URL = 'https://github.com/acme/test-state/pull/999';
		const CLEANUP_URLS: string[] = [TEST_PR_URL];

		afterEach(() => {
			const db = getDb();
			for (const url of CLEANUP_URLS) {
				db.run('DELETE FROM pr_review_state WHERE pr_url = ?', [url]);
			}
		});

		it('returns null for unknown PR URLs', () => {
			expect(getPrReviewState('https://github.com/acme/nope/pull/1')).toBeNull();
		});

		it('upserts and reads back review state', () => {
			upsertPrReviewState(TEST_PR_URL, 'deadbeef', '2026-04-01T10:00:00Z');
			const state = getPrReviewState(TEST_PR_URL);
			expect(state).not.toBeNull();
			expect(state!.last_reviewed_head_sha).toBe('deadbeef');
			expect(state!.last_reviewed_at).toBe('2026-04-01T10:00:00Z');
		});

		it('upsert overwrites existing state', () => {
			upsertPrReviewState(TEST_PR_URL, 'sha-one', '2026-04-01T10:00:00Z');
			upsertPrReviewState(TEST_PR_URL, 'sha-two', '2026-04-02T10:00:00Z');
			const state = getPrReviewState(TEST_PR_URL);
			expect(state!.last_reviewed_head_sha).toBe('sha-two');
			expect(state!.last_reviewed_at).toBe('2026-04-02T10:00:00Z');
		});
	});
});
