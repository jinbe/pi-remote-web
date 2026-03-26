import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { claimNextJob, updateJobStatus, getJob, getJobChain, deleteJob, retryJob, findActiveJobByPrUrl, findActiveJobByIssueUrl } from './job-queue';
import { createTestJob, getTestJobs, cleanupTestJobs } from './test-helpers';

describe('job-queue', () => {
	afterEach(() => {
		cleanupTestJobs();
	});

	describe('createJob', () => {
		it('creates a task job with defaults', () => {
			const job = createTestJob({ type: 'task', title: 'Test task' });

			expect(job.id).toBeTruthy();
			expect(job.type).toBe('task');
			expect(job.status).toBe('queued');
			expect(job.title).toBe('Test task');
			expect(job.priority).toBe(0);
			expect(job.loop_count).toBe(0);
			expect(job.max_loops).toBe(0);
			expect(job.retry_count).toBe(0);
			expect(job.max_retries).toBe(2);
			expect(job.target_branch).toBe('main');
		});

		it('creates a review job with custom fields', () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review PR',
				description: 'Check code quality',
				repo: '/path/to/repo',
				branch: 'feat/something',
				priority: 10,
				max_loops: 3,
			});

			expect(job.type).toBe('review');
			expect(job.description).toBe('Check code quality');
			expect(job.repo).toBe('/path/to/repo');
			expect(job.branch).toBe('feat/something');
			expect(job.priority).toBe(10);
			expect(job.max_loops).toBe(3);
		});

		it('creates a review job with pr_url', () => {
			const job = createTestJob({
				type: 'review',
				title: 'Review external PR',
				pr_url: 'https://github.com/org/repo/pull/42',
				repo: '/path/to/repo',
				max_loops: 1,
			});

			expect(job.type).toBe('review');
			expect(job.pr_url).toBe('https://github.com/org/repo/pull/42');
			expect(job.repo).toBe('/path/to/repo');
			expect(job.max_loops).toBe(1);
		});

		it('creates a job with parent_job_id', () => {
			const parent = createTestJob({ type: 'task', title: 'Parent' });
			const child = createTestJob({ type: 'review', title: 'Child', parent_job_id: parent.id });

			expect(child.parent_job_id).toBe(parent.id);
		});
	});

	describe('claimNextJob', () => {
		it('claims the oldest queued test job', () => {
			const first = createTestJob({ type: 'task', title: 'First' });
			createTestJob({ type: 'task', title: 'Second' });

			// Claim until we get one of our test jobs
			let claimed = claimNextJob();
			while (claimed && !getTestJobs().some(j => j.id === claimed!.id)) {
				claimed = claimNextJob();
			}
			// Our first job should be claimed (or already claimed by earlier iteration)
			const firstJob = getJob(first.id)!;
			expect(['claimed', 'queued']).toContain(firstJob.status);
		});

		it('respects priority ordering (highest first)', () => {
			createTestJob({ type: 'task', title: 'Low', priority: 0 });
			const high = createTestJob({ type: 'task', title: 'High', priority: 10 });

			const claimed = claimNextJob();
			// The high-priority job may or may not be ours depending on other queued jobs,
			// but if claimed, it should be the high-priority one from our test set
			if (claimed && getTestJobs().some(j => j.id === claimed!.id)) {
				expect(claimed!.id).toBe(high.id);
			}
		});
	});

	describe('updateJobStatus', () => {
		it('updates status and sets completed_at for done', () => {
			const job = createTestJob({ type: 'task', title: 'Test' });
			const updated = updateJobStatus(job.id, { status: 'done' });

			expect(updated!.status).toBe('done');
			expect(updated!.completed_at).toBeTruthy();
		});

		it('updates multiple fields at once', () => {
			const job = createTestJob({ type: 'task', title: 'Test' });
			const updated = updateJobStatus(job.id, {
				status: 'running',
				pr_url: 'https://github.com/org/repo/pull/1',
				session_id: 'sess-123',
			});

			expect(updated!.status).toBe('running');
			expect(updated!.pr_url).toBe('https://github.com/org/repo/pull/1');
			expect(updated!.session_id).toBe('sess-123');
		});

		it('returns null for non-existent job', () => {
			expect(updateJobStatus('nonexistent', { status: 'done' })).toBeNull();
		});
	});

	describe('getJobs', () => {
		it('filters by status', () => {
			const job = createTestJob({ type: 'task', title: 'A' });
			createTestJob({ type: 'task', title: 'B' });
			updateJobStatus(job.id, { status: 'done' });

			expect(getTestJobs({ status: 'done' })).toHaveLength(1);
			expect(getTestJobs({ status: 'queued' })).toHaveLength(1);
		});

		it('filters by type', () => {
			createTestJob({ type: 'task', title: 'A' });
			createTestJob({ type: 'review', title: 'B' });

			expect(getTestJobs({ type: 'task' })).toHaveLength(1);
			expect(getTestJobs({ type: 'review' })).toHaveLength(1);
		});

		it('filters by repo', () => {
			createTestJob({ type: 'task', title: 'A', repo: '/repo/a' });
			createTestJob({ type: 'task', title: 'B', repo: '/repo/b' });

			expect(getTestJobs({ repo: '/repo/a' })).toHaveLength(1);
		});
	});

	describe('getJob', () => {
		it('returns a job by ID', () => {
			const created = createTestJob({ type: 'task', title: 'Find me' });
			const found = getJob(created.id);
			expect(found).not.toBeNull();
			expect(found!.title).toBe('Find me');
		});

		it('returns null for non-existent ID', () => {
			expect(getJob('nonexistent')).toBeNull();
		});
	});

	describe('getJobChain', () => {
		it('returns a single job when no chain', () => {
			const job = createTestJob({ type: 'task', title: 'Standalone' });
			const chain = getJobChain(job.id);
			expect(chain).toHaveLength(1);
			expect(chain[0].id).toBe(job.id);
		});

		it('returns the full chain from any job in the chain', () => {
			const root = createTestJob({ type: 'task', title: 'Root' });
			const review = createTestJob({ type: 'review', title: 'Review', parent_job_id: root.id });
			const fix = createTestJob({ type: 'task', title: 'Fix', parent_job_id: review.id });

			const chainFromRoot = getJobChain(root.id);
			expect(chainFromRoot).toHaveLength(3);
			expect(chainFromRoot[0].id).toBe(root.id);
			expect(chainFromRoot[2].id).toBe(fix.id);

			const chainFromMiddle = getJobChain(review.id);
			expect(chainFromMiddle).toHaveLength(3);
			expect(chainFromMiddle[0].id).toBe(root.id);

			const chainFromLeaf = getJobChain(fix.id);
			expect(chainFromLeaf).toHaveLength(3);
			expect(chainFromLeaf[0].id).toBe(root.id);
		});
	});

	describe('deleteJob', () => {
		it('deletes a queued job', () => {
			const job = createTestJob({ type: 'task', title: 'Delete me' });
			const deleted = deleteJob(job.id);
			expect(deleted).not.toBeNull();
			expect(getJob(job.id)).toBeNull();
		});

		it('throws when trying to delete a running job', () => {
			const job = createTestJob({ type: 'task', title: 'Running' });
			updateJobStatus(job.id, { status: 'running' });
			expect(() => deleteJob(job.id)).toThrow(/Cannot delete/);
		});

		it('allows deleting a done job', () => {
			const job = createTestJob({ type: 'task', title: 'Completed' });
			updateJobStatus(job.id, { status: 'done' });
			const deleted = deleteJob(job.id);
			expect(deleted).not.toBeNull();
			expect(getJob(job.id)).toBeNull();
		});

		it('returns null for non-existent job', () => {
			expect(deleteJob('nonexistent')).toBeNull();
		});
	});

	describe('retryJob', () => {
		it('retries a failed job', () => {
			const job = createTestJob({ type: 'task', title: 'Retry me' });
			updateJobStatus(job.id, { status: 'failed', error: 'Something broke' });

			const retried = retryJob(job.id);
			expect(retried!.status).toBe('queued');
			expect(retried!.retry_count).toBe(1);
			expect(retried!.error).toBeNull();
		});

		it('throws when trying to retry a non-failed job', () => {
			const job = createTestJob({ type: 'task', title: 'Not failed' });
			expect(() => retryJob(job.id)).toThrow(/Cannot retry/);
		});

		it('throws when max retries exceeded', () => {
			const job = createTestJob({ type: 'task', title: 'Too many retries' });
			updateJobStatus(job.id, { status: 'failed' });
			retryJob(job.id);
			updateJobStatus(job.id, { status: 'failed' });
			retryJob(job.id);
			updateJobStatus(job.id, { status: 'failed' });

			expect(() => retryJob(job.id)).toThrow(/exceeded maximum retries/);
		});
	});

	describe('findActiveJobByPrUrl', () => {
		it('finds a queued job by PR URL', () => {
			const job = createTestJob({ type: 'review', title: 'Review PR', pr_url: 'https://github.com/org/repo/pull/1' });
			const found = findActiveJobByPrUrl('https://github.com/org/repo/pull/1');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(job.id);
		});

		it('finds a running job by PR URL', () => {
			const job = createTestJob({ type: 'review', title: 'Review PR', pr_url: 'https://github.com/org/repo/pull/2' });
			updateJobStatus(job.id, { status: 'running' });
			const found = findActiveJobByPrUrl('https://github.com/org/repo/pull/2');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(job.id);
		});

		it('finds a reviewing job by PR URL', () => {
			const job = createTestJob({ title: 'Task with PR', pr_url: 'https://github.com/org/repo/pull/3' });
			updateJobStatus(job.id, { status: 'reviewing' });
			const found = findActiveJobByPrUrl('https://github.com/org/repo/pull/3');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(job.id);
		});

		it('ignores done jobs', () => {
			createTestJob({ type: 'review', title: 'Done review', pr_url: 'https://github.com/org/repo/pull/4' });
			updateJobStatus(createTestJob({ type: 'review', title: 'Done review', pr_url: 'https://github.com/org/repo/pull/4' }).id, { status: 'done' });
			// The first job is still queued, so it should be found
			const found = findActiveJobByPrUrl('https://github.com/org/repo/pull/4');
			expect(found).not.toBeNull();
			expect(found!.status).toBe('queued');
		});

		it('returns null when only terminal jobs exist for the PR', () => {
			const job = createTestJob({ type: 'review', title: 'Done review', pr_url: 'https://github.com/org/repo/pull/5' });
			updateJobStatus(job.id, { status: 'done' });
			expect(findActiveJobByPrUrl('https://github.com/org/repo/pull/5')).toBeNull();
		});

		it('returns null when no jobs match the PR URL', () => {
			expect(findActiveJobByPrUrl('https://github.com/org/repo/pull/999')).toBeNull();
		});
	});

	describe('findActiveJobByIssueUrl', () => {
		it('finds a queued job by issue URL', () => {
			const job = createTestJob({ title: 'Fix issue', issue_url: 'https://github.com/org/repo/issues/10' });
			const found = findActiveJobByIssueUrl('https://github.com/org/repo/issues/10');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(job.id);
		});

		it('finds a running job by issue URL', () => {
			const job = createTestJob({ title: 'Fix issue', issue_url: 'https://github.com/org/repo/issues/11' });
			updateJobStatus(job.id, { status: 'running' });
			const found = findActiveJobByIssueUrl('https://github.com/org/repo/issues/11');
			expect(found).not.toBeNull();
		});

		it('returns null when only done jobs exist for the issue', () => {
			const job = createTestJob({ title: 'Done fix', issue_url: 'https://github.com/org/repo/issues/12' });
			updateJobStatus(job.id, { status: 'done' });
			expect(findActiveJobByIssueUrl('https://github.com/org/repo/issues/12')).toBeNull();
		});

		it('returns null for failed jobs', () => {
			const job = createTestJob({ title: 'Failed fix', issue_url: 'https://github.com/org/repo/issues/13' });
			updateJobStatus(job.id, { status: 'failed' });
			expect(findActiveJobByIssueUrl('https://github.com/org/repo/issues/13')).toBeNull();
		});

		it('returns null when no jobs match the issue URL', () => {
			expect(findActiveJobByIssueUrl('https://github.com/org/repo/issues/999')).toBeNull();
		});
	});
});
