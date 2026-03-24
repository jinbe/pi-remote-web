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
			const job = createJob({ type: 'task', title: 'Queued job' });
			updateJobStatus(job.id, { status: 'done' });

			const result = handleCompletion(job.id, { jobId: job.id, status: 'done' });
			
			// Should return the job as-is without error
			expect(result.status).toBe('done');
		});

		it('marks a failed job and cleans up', () => {
			const job = createJob({ type: 'task', title: 'Failing task' });
			updateJobStatus(job.id, { status: 'running' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'failed',
				error: 'Something went wrong',
			});

			expect(result.status).toBe('failed');
			expect(result.error).toBe('Something went wrong');

			// No follow-up jobs created in new model
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(1);
		});

		it('marks a job as done (simple completion - loop logic is in poller now)', () => {
			const job = createJob({
				type: 'task',
				title: 'Implement feature',
				repo: '/repo',
				branch: 'feat/test',
			});
			updateJobStatus(job.id, { status: 'running' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/1',
			});

			expect(result.status).toBe('done');
			expect(result.pr_url).toBe('https://github.com/org/repo/pull/1');

			// In the new model, handleCompletion doesn't create follow-up jobs
			const allJobs = getJobs();
			expect(allJobs).toHaveLength(1);
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
