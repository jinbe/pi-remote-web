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

		it('ignores completion for job already in terminal state', () => {
			const job = createJob({ title: 'Done job' });
			updateJobStatus(job.id, { status: 'done' });

			const result = handleCompletion(job.id, { jobId: job.id, status: 'done' });

			// Should return the job as-is without error
			expect(result.status).toBe('done');
		});

		it('marks a failed job directly', () => {
			const job = createJob({ title: 'Failing task' });
			updateJobStatus(job.id, { status: 'running' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'failed',
				error: 'Something went wrong',
			});

			expect(result.status).toBe('failed');
			expect(result.error).toBe('Something went wrong');
		});

		it('delegates to state machine — running job transitions to reviewing', async () => {
			const job = createJob({ title: 'Task with review', max_loops: 5 });
			updateJobStatus(job.id, { status: 'running' });

			handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/1',
			});

			const updated = getJob(job.id)!;
			// State machine transitions running → reviewing (not straight to done)
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/1');
		});

		it('delegates to state machine — fire-and-forget goes straight to done', async () => {
			const job = createJob({ title: 'Quick task', max_loops: 0 });
			updateJobStatus(job.id, { status: 'running' });

			handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/2',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/2');
		});

		it('delegates to state machine — review with approved verdict marks done', async () => {
			const job = createJob({ title: 'Reviewed task', max_loops: 5 });
			updateJobStatus(job.id, { status: 'reviewing' });

			handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				verdict: 'approved',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');
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
