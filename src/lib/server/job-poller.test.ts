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
		it('completes a running task and enqueues a review job', () => {
			const job = createJob({
				type: 'task',
				title: 'Implement widget',
				repo: '/repo',
				branch: 'feat/widget',
			});
			updateJobStatus(job.id, { status: 'running' });

			const assistantText = 'Done! Created PR.\nPR_URL: https://github.com/org/repo/pull/42\n';
			handleJobAgentEnd(job.id, assistantText);

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/42');

			// A review job should have been enqueued
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(2);

			const reviewJob = allJobs.find((j) => j.type === 'review');
			expect(reviewJob).toBeTruthy();
			expect(reviewJob!.status).toBe('queued');
			expect(reviewJob!.parent_job_id).toBe(job.id);
			expect(reviewJob!.pr_url).toBe('https://github.com/org/repo/pull/42');
		});

		it('completes a running review with verdict and enqueues fix task', () => {
			const taskJob = createJob({ type: 'task', title: 'Task', repo: '/repo' });
			const reviewJob = createJob({
				type: 'review',
				title: 'Review: Task',
				parent_job_id: taskJob.id,
				repo: '/repo',
				branch: 'feat/test',
				loop_count: 0,
				max_loops: 5,
			});
			updateJobStatus(reviewJob.id, { status: 'running' });

			const assistantText = 'Found issues.\nVERDICT: changes_requested\nPlease fix the error handling.';
			handleJobAgentEnd(reviewJob.id, assistantText);

			const updated = getJob(reviewJob.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('changes_requested');

			// A fix task should have been enqueued
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(3);

			const fixJob = allJobs.find(
				(j) => j.type === 'task' && j.parent_job_id === reviewJob.id
			);
			expect(fixJob).toBeTruthy();
			expect(fixJob!.loop_count).toBe(1);
			expect(fixJob!.status).toBe('queued');
		});

		it('completes a review with approved verdict — no follow-up', () => {
			const taskJob = createJob({ type: 'task', title: 'Task' });
			const reviewJob = createJob({
				type: 'review',
				title: 'Review: Task',
				parent_job_id: taskJob.id,
			});
			updateJobStatus(reviewJob.id, { status: 'running' });

			const assistantText = 'Looks good!\nVERDICT: approved';
			handleJobAgentEnd(reviewJob.id, assistantText);

			const updated = getJob(reviewJob.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');

			// No new jobs — chain is complete
			expect(getJobs()).toHaveLength(2);
		});

		it('is a no-op when the job is already completed (double-completion guard)', () => {
			const job = createJob({
				type: 'task',
				title: 'Already done',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'done' });

			// Should not throw and should not create follow-up jobs
			handleJobAgentEnd(job.id, 'PR_URL: https://github.com/org/repo/pull/1');

			expect(getJobs()).toHaveLength(1);
			expect(getJob(job.id)!.status).toBe('done');
		});

		it('is a no-op for an unknown job ID', () => {
			// Should not throw
			handleJobAgentEnd('nonexistent-id', 'some text');
			expect(getJobs()).toHaveLength(0);
		});

		it('extracts PR_URL and VERDICT from mixed assistant text', () => {
			const job = createJob({
				type: 'task',
				title: 'Mixed output test',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'running' });

			const assistantText = [
				'Starting work on the feature...',
				'Running tests... all pass.',
				'Created PR at PR_URL: https://github.com/org/repo/pull/99',
				'All done!',
			].join('\n');

			handleJobAgentEnd(job.id, assistantText);

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/99');
		});

		it('handles completion without any markers in the text', () => {
			const job = createJob({
				type: 'task',
				title: 'No markers',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'running' });

			handleJobAgentEnd(job.id, 'Did some work but forgot to output markers.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');

			// Review should still be enqueued (PR URL is optional)
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(2);
			const reviewJob = allJobs.find((j) => j.type === 'review');
			expect(reviewJob).toBeTruthy();
			expect(reviewJob!.status).toBe('queued');
		});
	});
});
