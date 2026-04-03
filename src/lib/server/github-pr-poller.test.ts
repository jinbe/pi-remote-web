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
	});
});
