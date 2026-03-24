import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { start, stop, isRunning, handleJobAgentEnd } from './job-poller';
import { getJob, updateJobStatus } from './job-queue';
import { createTestJob, getTestJobs, cleanupTestJobs } from './test-helpers';

describe('job-poller', () => {
	afterEach(() => {
		stop();
		cleanupTestJobs();
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
		it('claims a job and attempts dispatch (which fails without a real repo)', async () => {
			const { pollOnce } = await import('./job-poller');

			const job = createTestJob({
				type: 'task',
				title: 'Test poll',
				repo: '/nonexistent/repo/path',
			});

			await pollOnce();

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('not found');
		});
	});

	describe('handleJobAgentEnd', () => {
		it('extracts PR_URL when in running state', async () => {
			const job = createTestJob({
				type: 'task',
				title: 'Implement widget',
				repo: '/repo',
				branch: 'feat/widget',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			const assistantText = 'Done! Created PR.\nPR_URL: https://github.com/org/repo/pull/42\n';
			await handleJobAgentEnd(job.id, assistantText);

			const updated = getJob(job.id)!;
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/42');
		});

		it('is a no-op when the job is already in terminal state', async () => {
			const job = createTestJob({
				type: 'task',
				title: 'Already done',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'done' });

			await handleJobAgentEnd(job.id, 'PR_URL: https://github.com/org/repo/pull/1');

			expect(getJob(job.id)!.status).toBe('done');
		});

		it('is a no-op for an unknown job ID', async () => {
			await handleJobAgentEnd('nonexistent-id', 'some text');
		});

		it('extracts PR_URL from mixed assistant text', async () => {
			const job = createTestJob({
				type: 'task',
				title: 'Mixed output test',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			const assistantText = [
				'Starting work on the feature...',
				'Running tests... all pass.',
				'Created PR at PR_URL: https://github.com/org/repo/pull/99',
				'All done!',
			].join('\n');

			await handleJobAgentEnd(job.id, assistantText);

			const updated = getJob(job.id)!;
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/99');
		});

		it('transitions to reviewing (not done) when max_loops is 0 — awaiting manual review', async () => {
			const job = createTestJob({
				title: 'Fire and forget task',
				repo: '/repo',
				max_loops: 0,
			});
			updateJobStatus(job.id, { status: 'running' });

			await handleJobAgentEnd(job.id, 'Done!\nPR_URL: https://github.com/org/repo/pull/7');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/7');
		});

		it('stores model on job creation', () => {
			const job = createTestJob({
				title: 'Model test',
				repo: '/repo',
				model: 'anthropic/claude-sonnet-4',
			});
			expect(job.model).toBe('anthropic/claude-sonnet-4');
		});
	});
});
