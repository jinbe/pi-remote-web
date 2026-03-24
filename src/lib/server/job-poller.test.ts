import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { start, stop, isRunning } from './job-poller';
import { createJob, getJob, getJobs } from './job-queue';
import { getDb } from './cache';

function clearJobs() {
	getDb().run('DELETE FROM jobs');
}

describe('job-poller', () => {
	beforeEach(() => {
		clearJobs();
		stop(); // Ensure clean state
	});

	afterEach(() => {
		stop();
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
			start(); // Should not throw
			expect(isRunning()).toBe(true);
		});

		it('is idempotent — stopping when not running does not error', () => {
			stop(); // Should not throw
			expect(isRunning()).toBe(false);
		});
	});

	describe('pollOnce', () => {
		it('does nothing when no jobs are queued', async () => {
			const { pollOnce } = await import('./job-poller');
			await pollOnce(); // Should not throw
			expect(getJobs()).toHaveLength(0);
		});

		it('claims a job and attempts dispatch (which fails without a real repo)', async () => {
			const { pollOnce } = await import('./job-poller');

			// Create a job with a fake repo path — dispatch will fail
			// but the claim should still happen
			createJob({
				type: 'task',
				title: 'Test poll',
				repo: '/nonexistent/repo/path',
			});

			await pollOnce();

			const jobs = getJobs();
			expect(jobs).toHaveLength(1);

			// Job should be failed because the repo path doesn't exist
			const job = jobs[0];
			expect(job.status).toBe('failed');
			expect(job.error).toContain('not found');
		});
	});
});
