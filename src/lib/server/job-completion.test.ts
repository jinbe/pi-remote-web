import { describe, it, expect, afterEach } from 'bun:test';
import { handleCompletion, cwdToSessionDirName } from './job-completion';
import { getJob, updateJobStatus } from './job-queue';
import { createTestJob, cleanupTestJobs } from './test-helpers';

describe('job-completion', () => {
	afterEach(() => {
		cleanupTestJobs();
	});

	describe('handleCompletion', () => {
		it('throws for non-existent job', () => {
			expect(() =>
				handleCompletion('nonexistent', { jobId: 'nonexistent', status: 'done' })
			).toThrow(/not found/);
		});

		it('ignores completion for job already in terminal state', () => {
			const job = createTestJob({ title: 'Done job' });
			updateJobStatus(job.id, { status: 'done' });

			const result = handleCompletion(job.id, { jobId: job.id, status: 'done' });

			expect(result.status).toBe('done');
		});

		it('marks a failed job directly', () => {
			const job = createTestJob({ title: 'Failing task' });
			updateJobStatus(job.id, { status: 'running' });

			const result = handleCompletion(job.id, {
				jobId: job.id,
				status: 'failed',
				error: 'Something went wrong',
			});

			expect(result.status).toBe('failed');
			expect(result.error).toBe('Something went wrong');
		});

		it('delegates to state machine — running job transitions to reviewing', () => {
			const job = createTestJob({ title: 'Task with review', max_loops: 5 });
			updateJobStatus(job.id, { status: 'running' });

			handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/1',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/1');
		});

		it('delegates to state machine — fire-and-forget goes to reviewing (not done)', () => {
			const job = createTestJob({ title: 'Quick task', max_loops: 0 });
			updateJobStatus(job.id, { status: 'running' });

			handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/2',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/2');
		});

		it('delegates to state machine — review with approved verdict marks done', () => {
			const job = createTestJob({ title: 'Reviewed task', max_loops: 5 });
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
