import { describe, it, expect } from 'bun:test';
import { buildNudgeVerdictPrompt } from './job-prompts';
import type { Job } from './job-queue';

/** Minimal job fixture for prompt tests. */
function makeJob(overrides?: Partial<Job>): Job {
	return {
		id: 'test-job-id',
		type: 'review',
		status: 'running',
		priority: 0,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		claimed_at: null,
		completed_at: null,
		title: 'Test job',
		description: null,
		repo: '/repo',
		branch: null,
		issue_url: null,
		target_branch: 'main',
		pr_url: null,
		pr_number: null,
		review_verdict: null,
		parent_job_id: null,
		loop_count: 0,
		max_loops: 0,
		session_id: null,
		result_summary: null,
		error: null,
		retry_count: 0,
		max_retries: 2,
		no_verdict_retries: 0,
		max_no_verdict_retries: 3,
		callback_token: 'test-token',
		model: null,
		harness: 'pi',
		...overrides,
	};
}

describe('job-prompts', () => {
	describe('buildNudgeVerdictPrompt', () => {
		it('includes attempt number and max retries', () => {
			const job = makeJob({ max_no_verdict_retries: 3 });
			const prompt = buildNudgeVerdictPrompt(job, 1);

			expect(prompt).toContain('attempt 1 of 3');
		});

		it('includes both VERDICT markers', () => {
			const job = makeJob();
			const prompt = buildNudgeVerdictPrompt(job, 2);

			expect(prompt).toContain('VERDICT: approved');
			expect(prompt).toContain('VERDICT: changes_requested');
		});

		it('mentions the job will fail without a verdict', () => {
			const job = makeJob();
			const prompt = buildNudgeVerdictPrompt(job, 1);

			expect(prompt).toContain('FAIL');
		});

		it('mentions the agent stopped without a verdict', () => {
			const job = makeJob();
			const prompt = buildNudgeVerdictPrompt(job, 1);

			expect(prompt).toContain('stopped without providing a VERDICT');
		});

		it('includes the ABORT_JOB escape hatch', () => {
			const job = makeJob();
			const prompt = buildNudgeVerdictPrompt(job, 1);

			expect(prompt).toContain('ABORT_JOB:');
		});

		it('explains when to use ABORT_JOB', () => {
			const job = makeJob();
			const prompt = buildNudgeVerdictPrompt(job, 1);

			expect(prompt).toContain('unrecoverable error');
		});
	});
});
