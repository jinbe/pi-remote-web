import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { start, stop, isRunning, handleJobAgentEnd } from './job-poller';
import { createJob, getJob, getJobs, updateJobStatus } from './job-queue';
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

	describe('handleJobAgentEnd', () => {
		// Note: These tests can't fully test the state machine since sendMessage
		// requires a real Pi RPC session. The actual state transitions are tested
		// via integration tests. Here we just verify extraction and basic behaviour.

		it('extracts PR_URL when in running state', async () => {
			const job = createJob({
				type: 'task',
				title: 'Implement widget',
				repo: '/repo',
				branch: 'feat/widget',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			const assistantText = 'Done! Created PR.\nPR_URL: https://github.com/org/repo/pull/42\n';
			await handleJobAgentEnd(job.id, assistantText);

			const updated = getJob(job.id)!;
			//sendMessage will fail — but PR URL should be extracted before failure
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/42');
		});

		it('is a no-op when the job is already in terminal state', async () => {
			const job = createJob({
				type: 'task',
				title: 'Already done',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'done' });

			// Should not throw and should not change state
			await handleJobAgentEnd(job.id, 'PR_URL: https://github.com/org/repo/pull/1');

			expect(getJobs()).toHaveLength(1);
			expect(getJob(job.id)!.status).toBe('done');
		});

		it('is a no-op for an unknown job ID', async () => {
			// Should not throw
			await handleJobAgentEnd('nonexistent-id', 'some text');
			expect(getJobs()).toHaveLength(0);
		});

		it('extracts PR_URL from mixed assistant text', async () => {
			const job = createJob({
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

		it('skips review and goes straight to done when max_loops is 0', async () => {
			const job = createJob({
				title: 'Fire and forget task',
				repo: '/repo',
				max_loops: 0,
			});
			updateJobStatus(job.id, { status: 'running' });

			await handleJobAgentEnd(job.id, 'Done!\nPR_URL: https://github.com/org/repo/pull/7');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/7');
			// No reviewing state — went straight to done
		});

		it('stores model on job creation', () => {
			const job = createJob({
				title: 'Model test',
				repo: '/repo',
				model: 'anthropic/claude-sonnet-4',
			});
			expect(job.model).toBe('anthropic/claude-sonnet-4');
		});
	});
});
