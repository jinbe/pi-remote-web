import { describe, it, expect, beforeEach } from 'bun:test';
import { handleCompletion, cwdToSessionDirName } from './job-completion';
import { createJob, getJob, getJobs, updateJobStatus } from './job-queue';
import { getDb } from './cache';

function clearJobs() {
	getDb().run('DELETE FROM jobs');
}

describe('job-completion', () => {
	beforeEach(() => {
		clearJobs();
	});

	describe('handleCompletion', () => {
		it('throws for non-existent job', () => {
			expect(() =>
				handleCompletion('nonexistent', { jobId: 'nonexistent', status: 'done' })
			).toThrow(/not found/);
		});

		it('throws for job not in running/claimed status', () => {
			const job = createJob({ type: 'task', title: 'Queued job' });

			expect(() =>
				handleCompletion(job.id, { jobId: job.id, status: 'done' })
			).toThrow(/not running/);
		});

		it('marks a failed job and does not enqueue follow-up', () => {
			const job = createJob({ type: 'task', title: 'Failing task' });
			updateJobStatus(job.id, { status: 'running' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'failed',
				error: 'Something went wrong',
			});

			expect(result.status).toBe('failed');
			expect(result.error).toBe('Something went wrong');

			// No follow-up jobs should have been created
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(1);
		});

		it('completes a task and enqueues a review with inherited worktree_path', () => {
			const job = createJob({
				type: 'task',
				title: 'Implement feature',
				repo: '/repo',
				branch: 'feat/test',
			});
			updateJobStatus(job.id, { status: 'running', worktree_path: '/tmp/worktree-123' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/1',
			});

			expect(result.status).toBe('done');
			expect(result.pr_url).toBe('https://github.com/org/repo/pull/1');

			// A review job should have been enqueued
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(2);

			const reviewJob = allJobs.find((j) => j.type === 'review');
			expect(reviewJob).toBeTruthy();
			expect(reviewJob!.parent_job_id).toBe(job.id);
			expect(reviewJob!.status).toBe('queued');
			expect(reviewJob!.pr_url).toBe('https://github.com/org/repo/pull/1');
			// Review inherits the worktree path for cleanup after review
			expect(reviewJob!.worktree_path).toBe('/tmp/worktree-123');
		});

		it('completes a review with approved verdict — no follow-up', () => {
			const taskJob = createJob({ type: 'task', title: 'Task' });
			const reviewJob = createJob({
				type: 'review',
				title: 'Review: Task',
				parent_job_id: taskJob.id,
			});
			updateJobStatus(reviewJob.id, { status: 'running' });

			handleCompletion(reviewJob.id, {
				jobId: reviewJob.id,
				status: 'done',
				verdict: 'approved',
			});

			const allJobs = getJobs();
			expect(allJobs).toHaveLength(2); // No new jobs created
		});

		it('completes a review with changes_requested — enqueues fix task', () => {
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

			handleCompletion(reviewJob.id, {
				jobId: reviewJob.id,
				status: 'done',
				verdict: 'changes_requested',
			});

			const allJobs = getJobs();
			expect(allJobs).toHaveLength(3);

			const fixJob = allJobs.find(
				(j) => j.type === 'task' && j.parent_job_id === reviewJob.id
			);
			expect(fixJob).toBeTruthy();
			expect(fixJob!.loop_count).toBe(1);
			expect(fixJob!.status).toBe('queued');
		});

		it('does not enqueue review when loop cap is reached', () => {
			const job = createJob({
				type: 'task',
				title: 'Capped task',
				loop_count: 5,
				max_loops: 5,
			});
			updateJobStatus(job.id, { status: 'running' });

			handleCompletion(job.id, { jobId: job.id, status: 'done' });

			const allJobs = getJobs();
			expect(allJobs).toHaveLength(1); // No review enqueued
		});

		it('does not enqueue fix when review loop cap is reached', () => {
			const reviewJob = createJob({
				type: 'review',
				title: 'Review at cap',
				loop_count: 4,
				max_loops: 5,
			});
			updateJobStatus(reviewJob.id, { status: 'running' });

			handleCompletion(reviewJob.id, {
				jobId: reviewJob.id,
				status: 'done',
				verdict: 'changes_requested',
			});

			const allJobs = getJobs();
			expect(allJobs).toHaveLength(1); // No fix enqueued
		});
	});

	describe('cwdToSessionDirName', () => {
		it('converts absolute path to pi session dir name', () => {
			expect(cwdToSessionDirName('/Users/jchan/code/my-project')).toBe(
				'--Users-jchan-code-my-project--'
			);
		});

		it('handles paths with colons (Windows-style)', () => {
			expect(cwdToSessionDirName('C:\\Users\\dev\\project')).toBe(
				'--C--Users-dev-project--'
			);
		});

		it('strips leading slash', () => {
			const result = cwdToSessionDirName('/foo/bar');
			expect(result).toBe('--foo-bar--');
			expect(result.startsWith('---')).toBe(false);
		});
	});
});
