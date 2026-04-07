import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';

// Mock rpc-manager so tests are isolated from cross-file mock.module leaks
// (cmux-manager.test.ts mocks isActive to return true, which poisons the
// global module cache when bun runs tests in the same process).
//
// NOTE: Bun's mock.module() overrides persist in the ES module registry for
// the lifetime of the process — mock.restore() explicitly does NOT undo them
// (per Bun docs). There is no public API to remove a mock.module override.
// We call mock.restore() in afterAll for spy cleanup and re-register the real
// module via mock.module() to minimise leakage into subsequent test files.

// Capture the real module exports *before* mock.module is applied.
// mock.module is hoisted, so we use require.resolve + a dynamic require to
// grab the real implementation at the resolved path.
const rpcManagerPath = require.resolve('./rpc-manager');
const realRpcManager = require(rpcManagerPath);

const mockIsActive = mock(() => false);
const mockSendMessage = mock(() => Promise.reject(new Error('no real session')));
const mockStopSession = mock(() => Promise.resolve());
const mockCreateSession = mock(() => Promise.resolve('mock-session'));
const mockGetHarness = mock(() => 'pi' as const);

mock.module('./rpc-manager', () => ({
	isActive: mockIsActive,
	sendMessage: mockSendMessage,
	stopSession: mockStopSession,
	createSession: mockCreateSession,
	getHarness: mockGetHarness,
}));

import { start, stop, isRunning, handleJobAgentEnd, recoverOrphanedJobs, _resetForTesting } from './job-poller';
import { getJob, updateJobStatus } from './job-queue';
import { createTestJob, getTestJobs, cleanupTestJobs } from './test-helpers';

describe('job-poller', () => {
	afterEach(() => {
		stop();
		_resetForTesting();
		cleanupTestJobs();
	});

	afterAll(() => {
		// Restore spy state (call counts, mockImplementation, etc.)
		mock.restore();
		// Re-register the real rpc-manager so subsequent test files that
		// import it without their own mock.module() get the real exports.
		mock.module('./rpc-manager', () => realRpcManager);
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

	describe('handleJobAgentEnd — no verdict nudge retry', () => {
		it('fails review-type job without verdict when session is inactive (nudge cannot be sent)', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review with no verdict',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/50',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			await handleJobAgentEnd(job.id, 'I reviewed the code but forgot the verdict.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('VERDICT');
			expect(updated.error).toContain('retry');
		});

		it('fails reviewing-phase job without verdict when session is inactive (nudge cannot be sent)', async () => {
			const job = createTestJob({
				title: 'Task review no verdict',
				repo: '/repo',
				max_loops: 3,
			});
			updateJobStatus(job.id, { status: 'reviewing', session_id: 'test-session' });

			await handleJobAgentEnd(job.id, 'I looked at the changes but no verdict.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('VERDICT');
			expect(updated.error).toContain('retry');
		});

		it('includes retry count in error message when nudges are exhausted', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Exhausted nudges',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/60',
			});
			// Simulate having already used all nudge retries
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session', no_verdict_retries: 3 });

			await handleJobAgentEnd(job.id, 'No verdict here.');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('3 retry');
		});

		it('defaults max_no_verdict_retries to 3', () => {
			const job = createTestJob({
				title: 'Check defaults',
				repo: '/repo',
			});
			expect(job.no_verdict_retries).toBe(0);
			expect(job.max_no_verdict_retries).toBe(3);
		});
	});

	describe('handleJobAgentEnd — ABORT_JOB', () => {
		it('immediately fails a running review job during nudge retry when ABORT_JOB is present', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review missing PR',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/404',
			});
			// Simulate being in a nudge retry (no_verdict_retries > 0)
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session', no_verdict_retries: 1 });

			await handleJobAgentEnd(job.id, 'The PR does not exist.\nABORT_JOB: PR not found - repository returned 404');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('Aborted by agent');
			expect(updated.error).toContain('PR not found');
		});

		it('immediately fails a reviewing-phase job during nudge retry when ABORT_JOB is present', async () => {
			const job = createTestJob({
				title: 'Task with bad repo',
				repo: '/repo',
				max_loops: 3,
			});
			updateJobStatus(job.id, { status: 'reviewing', session_id: 'test-session', no_verdict_retries: 2 });

			await handleJobAgentEnd(job.id, 'Cannot find the repo.\nABORT_JOB: Repository does not exist');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('Aborted by agent');
			expect(updated.error).toContain('Repository does not exist');
		});

		it('ABORT_JOB takes precedence over VERDICT marker during nudge retry', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Conflicting markers',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session', no_verdict_retries: 1 });

			await handleJobAgentEnd(job.id, 'VERDICT: approved\nABORT_JOB: Something is fundamentally wrong');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			expect(updated.error).toContain('Aborted by agent');
		});

		it('ABORT_JOB skips remaining nudge retries', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Skip remaining nudges',
				repo: '/repo',
			});
			// First nudge was sent, still has retries remaining
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session', no_verdict_retries: 1 });

			await handleJobAgentEnd(job.id, 'ABORT_JOB: Issue cannot be found');

			const updated = getJob(job.id)!;
			expect(updated.status).toBe('failed');
			// no_verdict_retries should not have been incremented further
			expect(updated.no_verdict_retries).toBe(1);
		});

		it('ignores ABORT_JOB during normal runs (no_verdict_retries is 0)', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Normal run with ABORT_JOB in text',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/42',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			// Agent happens to mention ABORT_JOB but also gives a verdict
			await handleJobAgentEnd(job.id, 'ABORT_JOB: this text should be ignored\nVERDICT: approved');

			const updated = getJob(job.id)!;
			// Should process normally — ABORT_JOB ignored, verdict honoured
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');
		});

		it('does not abort for terminal-state jobs', async () => {
			const job = createTestJob({
				title: 'Already done',
				repo: '/repo',
			});
			updateJobStatus(job.id, { status: 'done' });

			await handleJobAgentEnd(job.id, 'ABORT_JOB: Too late');

			expect(getJob(job.id)!.status).toBe('done');
		});
	});

	describe('handleJobAgentEnd — concurrency', () => {
		it('serialises concurrent calls so a late empty-text call does not spuriously nudge', async () => {
			const job = createTestJob({
				type: 'review',
				title: 'Race condition test',
				repo: '/repo',
				pr_url: 'https://github.com/org/repo/pull/99',
			});
			updateJobStatus(job.id, { status: 'running', session_id: 'test-session' });

			// Fire two concurrent calls: one with a verdict, one with empty text
			// (simulates agent_end + session_ended racing)
			const call1 = handleJobAgentEnd(job.id, 'Looks good!\nVERDICT: approved');
			const call2 = handleJobAgentEnd(job.id, '');

			await Promise.all([call1, call2]);

			const updated = getJob(job.id)!;
			// Should be done (from the first call), not failed/nudged by the second
			expect(updated.status).toBe('done');
			expect(updated.review_verdict).toBe('approved');
			expect(updated.no_verdict_retries).toBe(0);
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
