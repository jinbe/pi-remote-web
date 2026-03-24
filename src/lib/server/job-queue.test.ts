import { describe, it, expect, beforeEach } from 'bun:test';
import { createJob, claimNextJob, updateJobStatus, getJobs, getJob, getJobChain, deleteJob, retryJob, type Job } from './job-queue';
import { getDb } from './cache';

function clearJobs() {
	getDb().run('DELETE FROM jobs');
}

describe('job-queue', () => {
	beforeEach(() => {
		clearJobs();
	});

	describe('createJob', () => {
		it('creates a task job with defaults', () => {
			const job = createJob({ type: 'task', title: 'Test task' });

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
			const job = createJob({
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

		it('creates a job with parent_job_id', () => {
			const parent = createJob({ type: 'task', title: 'Parent' });
			const child = createJob({ type: 'review', title: 'Child', parent_job_id: parent.id });

			expect(child.parent_job_id).toBe(parent.id);
		});
	});

	describe('claimNextJob', () => {
		it('returns null when no jobs are queued', () => {
			expect(claimNextJob()).toBeNull();
		});

		it('claims the oldest queued job', () => {
			const first = createJob({ type: 'task', title: 'First' });
			createJob({ type: 'task', title: 'Second' });

			const claimed = claimNextJob();
			expect(claimed).not.toBeNull();
			expect(claimed!.id).toBe(first.id);
			expect(claimed!.status).toBe('claimed');
			expect(claimed!.claimed_at).toBeTruthy();
		});

		it('respects priority ordering (highest first)', () => {
			createJob({ type: 'task', title: 'Low', priority: 0 });
			const high = createJob({ type: 'task', title: 'High', priority: 10 });

			const claimed = claimNextJob();
			expect(claimed!.id).toBe(high.id);
		});

		it('does not claim already-claimed jobs', () => {
			createJob({ type: 'task', title: 'Only one' });

			const first = claimNextJob();
			const second = claimNextJob();

			expect(first).not.toBeNull();
			expect(second).toBeNull();
		});
	});

	describe('updateJobStatus', () => {
		it('updates status and sets completed_at for done', () => {
			const job = createJob({ type: 'task', title: 'Test' });
			const updated = updateJobStatus(job.id, { status: 'done' });

			expect(updated!.status).toBe('done');
			expect(updated!.completed_at).toBeTruthy();
		});

		it('updates multiple fields at once', () => {
			const job = createJob({ type: 'task', title: 'Test' });
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
		it('returns all jobs when no filters', () => {
			createJob({ type: 'task', title: 'A' });
			createJob({ type: 'review', title: 'B' });

			expect(getJobs()).toHaveLength(2);
		});

		it('filters by status', () => {
			const job = createJob({ type: 'task', title: 'A' });
			createJob({ type: 'task', title: 'B' });
			updateJobStatus(job.id, { status: 'done' });

			expect(getJobs({ status: 'done' })).toHaveLength(1);
			expect(getJobs({ status: 'queued' })).toHaveLength(1);
		});

		it('filters by type', () => {
			createJob({ type: 'task', title: 'A' });
			createJob({ type: 'review', title: 'B' });

			expect(getJobs({ type: 'task' })).toHaveLength(1);
			expect(getJobs({ type: 'review' })).toHaveLength(1);
		});

		it('filters by repo', () => {
			createJob({ type: 'task', title: 'A', repo: '/repo/a' });
			createJob({ type: 'task', title: 'B', repo: '/repo/b' });

			expect(getJobs({ repo: '/repo/a' })).toHaveLength(1);
		});
	});

	describe('getJob', () => {
		it('returns a job by ID', () => {
			const created = createJob({ type: 'task', title: 'Find me' });
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
			const job = createJob({ type: 'task', title: 'Standalone' });
			const chain = getJobChain(job.id);
			expect(chain).toHaveLength(1);
			expect(chain[0].id).toBe(job.id);
		});

		it('returns the full chain from any job in the chain', () => {
			const root = createJob({ type: 'task', title: 'Root' });
			const review = createJob({ type: 'review', title: 'Review', parent_job_id: root.id });
			const fix = createJob({ type: 'task', title: 'Fix', parent_job_id: review.id });

			// Get chain from root
			const chainFromRoot = getJobChain(root.id);
			expect(chainFromRoot).toHaveLength(3);
			expect(chainFromRoot[0].id).toBe(root.id);
			expect(chainFromRoot[2].id).toBe(fix.id);

			// Get chain from middle
			const chainFromMiddle = getJobChain(review.id);
			expect(chainFromMiddle).toHaveLength(3);
			expect(chainFromMiddle[0].id).toBe(root.id);

			// Get chain from leaf
			const chainFromLeaf = getJobChain(fix.id);
			expect(chainFromLeaf).toHaveLength(3);
			expect(chainFromLeaf[0].id).toBe(root.id);
		});
	});

	describe('deleteJob', () => {
		it('deletes a queued job', () => {
			const job = createJob({ type: 'task', title: 'Delete me' });
			const deleted = deleteJob(job.id);
			expect(deleted).not.toBeNull();
			expect(getJob(job.id)).toBeNull();
		});

		it('throws when trying to delete a running job', () => {
			const job = createJob({ type: 'task', title: 'Running' });
			updateJobStatus(job.id, { status: 'running' });
			expect(() => deleteJob(job.id)).toThrow(/Cannot delete/);
		});

		it('allows deleting a done job', () => {
			const job = createJob({ type: 'task', title: 'Completed' });
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
			const job = createJob({ type: 'task', title: 'Retry me' });
			updateJobStatus(job.id, { status: 'failed', error: 'Something broke' });

			const retried = retryJob(job.id);
			expect(retried!.status).toBe('queued');
			expect(retried!.retry_count).toBe(1);
			expect(retried!.error).toBeNull();
		});

		it('throws when trying to retry a non-failed job', () => {
			const job = createJob({ type: 'task', title: 'Not failed' });
			expect(() => retryJob(job.id)).toThrow(/Cannot retry/);
		});

		it('throws when max retries exceeded', () => {
			const job = createJob({ type: 'task', title: 'Too many retries' });
			updateJobStatus(job.id, { status: 'failed' });
			retryJob(job.id);
			updateJobStatus(job.id, { status: 'failed' });
			retryJob(job.id);
			updateJobStatus(job.id, { status: 'failed' });

			expect(() => retryJob(job.id)).toThrow(/exceeded maximum retries/);
		});
	});
});
