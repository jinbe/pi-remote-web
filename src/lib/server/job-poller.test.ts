import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { start, stop, isRunning, handleJobAgentEnd, recoverOrphanedJobs, _resetForTesting } from './job-poller';
import { getJob, updateJobStatus } from './job-queue';
import { createTestJob, getTestJobs, cleanupTestJobs } from './test-helpers';

describe('job-poller', () => {
	afterEach(() => {
		stop();
		_resetForTesting();
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

		it('transitions to reviewing when max_loops is 0 and PR exists (fire-and-forget)', async () => {
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

		it('transitions to reviewing when max_loops is 0 but no PR (fire-and-forget without PR)', async () => {
			const job = createTestJob({
				title: 'Fire and forget no PR',
				repo: '/repo',
				max_loops: 0,
			});
			updateJobStatus(job.id, { status: 'running' });

			await handleJobAgentEnd(job.id, 'Done! No PR created.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
		});

		it('stores model on job creation', () => {
			const job = createTestJob({
				title: 'Model test',
				repo: '/repo',
				model: 'anthropic/claude-sonnet-4',
			});
			expect(job.model).toBe('anthropic/claude-sonnet-4');
		});

		it('fire-and-forget job stays in reviewing when handleJobAgentEnd is called again', async () => {
			const job = createTestJob({
				title: 'Fire-and-forget review guard',
				repo: '/repo',
				max_loops: 0,
			});
			// Simulate the race condition: job is already in reviewing state
			updateJobStatus(job.id, { status: 'reviewing', pr_url: 'https://github.com/org/repo/pull/5' });

			// Extension callback fires a second agent_end with an approved verdict
			await handleJobAgentEnd(job.id, 'Everything looks great!\nVERDICT: approved');

			// Status must remain reviewing — no automated transition for fire-and-forget
			const updated = getJob(job.id)!;
			expect(updated.status).toBe('reviewing');
		});
	});

	describe('handleJobAgentEnd — review jobs', () => {
		it('goes straight to done with verdict for review-type jobs', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review PR #42',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/42',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			await handleJobAgentEnd(job.id, 'Looks good!\nVERDICT: approved');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');
		});

		it('handles changes_requested verdict for review-type jobs', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review PR #42',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/42',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			await handleJobAgentEnd(job.id, 'Needs work.\nVERDICT: changes_requested');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('changes_requested');
		});

		it('fails review-type job when no verdict is found', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review PR #42',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/42',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			await handleJobAgentEnd(job.id, 'I looked at the code but forgot the verdict.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('VERDICT');
		});
	});

	describe('recoverOrphanedJobs', () => {
		it('re-queues a claimed job with no session_id', () => {
			const job = createTestJob({ title: 'Orphaned claimed', repo: '/repo' });
			updateJobStatus(job.id, { status: 'claimed' as any });

			recoverOrphanedJobs();

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('queued');
			expect(updated.claimed_at).toBeNull();
		});

		it('re-queues a running job with no session_id', () => {
			const job = createTestJob({ title: 'Orphaned running', repo: '/repo' });
			updateJobStatus(job.id, { status: 'running' as any });

			recoverOrphanedJobs();

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('queued');
		});

		it('does not touch a running job that has a session_id', () => {
			const job = createTestJob({ title: 'Active running', repo: '/repo' });
			updateJobStatus(job.id, { status: 'running', session_id: 'sess-123' });

			recoverOrphanedJobs();

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('running');
			expect(updated.session_id).toBe('sess-123');
		});

		it('does not touch jobs in terminal states', () => {
			const done = createTestJob({ title: 'Done job', repo: '/repo' });
			updateJobStatus(done.id, { status: 'done' });

			const failed = createTestJob({ title: 'Failed job', repo: '/repo' });
			updateJobStatus(failed.id, { status: 'failed', error: 'oops' });

			recoverOrphanedJobs();

			expect(getJob(done.id)!.status).toBe('done');
			expect(getJob(failed.id)!.status).toBe('failed');
		});
	});
});
