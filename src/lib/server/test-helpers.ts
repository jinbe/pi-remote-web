/**
 * Test helpers for job tests. Tracks created job IDs and provides
 * scoped cleanup so tests don't wipe the entire jobs table.
 */
import { createJob as _createJob, deleteJob, updateJobStatus, getJobs as _getJobs, type Job, type CreateJobInput } from './job-queue';
import { getDb } from './cache';

/** IDs of jobs created during the current test. */
let testJobIds: string[] = [];

/** Create a job and track its ID for cleanup. */
export function createTestJob(input: CreateJobInput): Job {
	const job = _createJob(input);
	testJobIds.push(job.id);
	return job;
}

/**
 * Get only jobs created during this test.
 * Accepts the same filters as getJobs, but scoped to test-created jobs.
 */
export function getTestJobs(filters?: Parameters<typeof _getJobs>[0]): Job[] {
	const all = _getJobs(filters);
	return all.filter(j => testJobIds.includes(j.id));
}

/** Clean up only jobs created during this test. */
export function cleanupTestJobs(): void {
	const db = getDb();
	for (const id of testJobIds) {
		// Force-delete regardless of status
		db.run('DELETE FROM jobs WHERE id = ?', [id]);
	}
	testJobIds = [];
}
