import { describe, it, expect, afterEach } from 'bun:test';
import { handleCompletion, cwdToSessionDirName } from './job-completion';
import { getJob, updateJobStatus } from './job-queue';
import { createTestJob, cleanupTestJobs } from './test-helpers';

describe('job-completion', () => {
	afterEach(() => {
		cleanupTestJobs();
	});

	describe('handleCompletion', () => {
		it('throws for non-existent job', async () => {
			await expect(
				handleCompletion('nonexistent', { jobId: 'nonexistent', status: 'done' })
			).rejects.toThrow(/not found/);
		});

		it('ignores completion for job already in terminal state', async () => {
			const job = createTestJob({ title: 'Done job' });
			updateJobStatus(job.id, { status: 'done' });

			const result = await handleCompletion(job.id, { jobId: job.id, status: 'done' });

			expect(result.status).toBe('done');
		});

		it('marks a failed job directly', async () => {
			const job = createTestJob({ title: 'Failing task' });
			updateJobStatus(job.id, { status: 'running' });

			const result = await handleCompletion(job.id, {
				jobId: job.id,
				status: 'failed',
				error: 'Something went wrong',
			});

			expect(result.status).toBe('failed');
			expect(result.error).toBe('Something went wrong');
		});

		it('delegates to state machine — running job transitions to reviewing', async () => {
			const job = createTestJob({ title: 'Task with review', max_loops: 5 });
			updateJobStatus(job.id, { status: 'running' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				prUrl: 'https://github.com/org/repo/pull/1',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/1');
		});

		it('delegates to state machine — fire-and-forget with PR goes to reviewing', async () => {
			const job = createTestJob({ title: 'Quick task', max_loops: 0 });
			updateJobStatus(job.id, { status: 'running' });

			// Extension callback sends 'reviewing' (not 'done') for task completions
			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'reviewing',
				prUrl: 'https://github.com/org/repo/pull/2',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/2');
		});

		it('delegates to state machine — fire-and-forget without PR goes to reviewing', async () => {
			const job = createTestJob({ title: 'Quick task no PR', max_loops: 0 });
			updateJobStatus(job.id, { status: 'running' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'reviewing',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
		});

		it('delegates to state machine — review with approved verdict marks done', async () => {
			const job = createTestJob({ title: 'Reviewed task', max_loops: 5 });
			updateJobStatus(job.id, { status: 'reviewing' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				verdict: 'approved',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');
		});

		it('fire-and-forget job in reviewing ignores completion callback', async () => {
			// Simulates the race condition: extension callback fires after the session
			// subscription already moved the job to reviewing. Fire-and-forget jobs
			// (max_loops=0) must remain in reviewing for manual review.
			const job = createTestJob({ title: 'Fire-and-forget guard', max_loops: 0 });
			updateJobStatus(job.id, { status: 'reviewing', pr_url: 'https://github.com/org/repo/pull/3' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'done',
				verdict: 'approved',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
		});

		it('callback patches missing pr_url when job already in reviewing (race condition)', async () => {
			// Subscription moved job to reviewing without capturing PR_URL,
			// then the extension callback arrives with the PR URL.
			const job = createTestJob({ title: 'Race patch PR', max_loops: 0 });
			updateJobStatus(job.id, { status: 'reviewing' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'reviewing',
				prUrl: 'https://github.com/org/repo/pull/10',
			});

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/10');
		});

		it('callback does not overwrite existing pr_url when job already in reviewing', async () => {
			// Subscription already captured PR_URL; callback should not replace it.
			const job = createTestJob({ title: 'Race no overwrite', max_loops: 0 });
			updateJobStatus(job.id, { status: 'reviewing', pr_url: 'https://github.com/org/repo/pull/original' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'reviewing',
				prUrl: 'https://github.com/org/repo/pull/from-callback',
			});

			const updated = getJob(job.id)!;
			expect(updated.pr_url).toBe('https://github.com/org/repo/pull/original');
		});

		it('callback with reviewing status does not fail looped job already in reviewing', async () => {
			// This is the critical race: a max_loops > 0 job is in reviewing (subscription
			// transitioned it), then the extension callback arrives with status 'reviewing'
			// and no verdict. Without the guard, handleJobAgentEnd would mark it as failed.
			const job = createTestJob({ title: 'Looped race guard', max_loops: 3 });
			updateJobStatus(job.id, { status: 'reviewing', pr_url: 'https://github.com/org/repo/pull/5' });

			await handleCompletion(job.id, {
				jobId: job.id,
				status: 'reviewing',
				prUrl: 'https://github.com/org/repo/pull/5',
			});

			const updated = getJob(job.id)!;
			// Must remain in reviewing — not failed
			expect(updated.status).toBe('reviewing');
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
