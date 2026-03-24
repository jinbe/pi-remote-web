/**
 * Job queue operations — CRUD and atomic claim for the jobs table.
 * All database access for jobs goes through this module.
 */
import { getDb } from './cache';
import { log } from './logger';
import { emitJobEvent } from './job-events';

// --- Types ---

export interface Job {
	id: string;
	type?: 'task' | 'review' | null; // Deprecated - kept for backwards compatibility
	status: 'queued' | 'claimed' | 'running' | 'reviewing' | 'done' | 'failed' | 'cancelled';
	priority: number;
	created_at: string;
	updated_at: string;
	claimed_at: string | null;
	completed_at: string | null;
	title: string;
	description: string | null;
	repo: string | null;
	branch: string | null;
	issue_url: string | null;
	target_branch: string;
	pr_url: string | null;
	pr_number: number | null;
	review_verdict: 'approved' | 'changes_requested' | null;
	parent_job_id: string | null;
	loop_count: number;
	max_loops: number;
	session_id: string | null;
	worktree_path: string | null;
	result_summary: string | null;
	error: string | null;
	retry_count: number;
	max_retries: number;
	callback_token: string;
	review_skill: string | null;
	model: string | null;
}

export interface CreateJobInput {
	type?: 'task' | 'review'; // Deprecated - optional for backwards compatibility
	title: string;
	description?: string;
	repo?: string;
	branch?: string;
	issue_url?: string;
	target_branch?: string;
	priority?: number;
	parent_job_id?: string;
	loop_count?: number;
	max_loops?: number;
	pr_url?: string;
	review_skill?: string;
	model?: string;
}

export interface UpdateJobInput {
	status?: Job['status'];
	pr_url?: string;
	pr_number?: number;
	review_verdict?: Job['review_verdict'];
	session_id?: string;
	worktree_path?: string;
	result_summary?: string;
	error?: string;
	branch?: string;
	review_skill?: string;
	loop_count?: number;
}

// --- Query helpers ---
// Statements are created fresh from getDb() each call to avoid holding stale
// references if the Database instance is ever re-created (e.g. during tests).
// bun:sqlite's db.query() overhead is negligible.

function insertJobQuery() {
	return getDb().query(`
		INSERT INTO jobs (type, title, description, repo, branch, issue_url, target_branch, priority, parent_job_id, loop_count, max_loops, pr_url, review_skill, model)
		VALUES ($type, $title, $description, $repo, $branch, $issue_url, $target_branch, $priority, $parent_job_id, $loop_count, $max_loops, $pr_url, $review_skill, $model)
		RETURNING *
	`);
}

function claimQuery() {
	return getDb().query(`
		UPDATE jobs
		SET status = 'claimed', claimed_at = datetime('now'), updated_at = datetime('now')
		WHERE id = (
			SELECT id FROM jobs
			WHERE status = 'queued'
			ORDER BY priority DESC, created_at ASC
			LIMIT 1
		)
		RETURNING *
	`);
}

function getJobQuery() {
	return getDb().query('SELECT * FROM jobs WHERE id = ?');
}

function deleteJobQuery() {
	return getDb().query('DELETE FROM jobs WHERE id = ? RETURNING *');
}

// --- Public API ---

/**
 * Create a new job in the queue.
 */
export function createJob(input: CreateJobInput): Job {
	const row = insertJobQuery().get({
		$type: input.type ?? 'task', // Default to 'task' for backwards compatibility
		$title: input.title,
		$description: input.description ?? null,
		$repo: input.repo ?? null,
		$branch: input.branch ?? null,
		$issue_url: input.issue_url ?? null,
		$target_branch: input.target_branch ?? 'main',
		$priority: input.priority ?? 0,
		$parent_job_id: input.parent_job_id ?? null,
		$loop_count: input.loop_count ?? 0,
		$max_loops: input.max_loops ?? 0,
		$pr_url: input.pr_url ?? null,
		$review_skill: input.review_skill ?? null,
		$model: input.model ?? null,
	}) as Job;

	log.info('job-queue', `created job ${row.id} (${row.type ?? 'task'}): ${row.title}`);
	emitJobEvent({ type: 'job_created', jobId: row.id, status: row.status });
	return row;
}

/**
 * Atomically claim the next queued job (highest priority, oldest first).
 * Returns null if no jobs are available.
 */
export function claimNextJob(): Job | null {
	const row = claimQuery().get() as Job | null;
	if (row) {
		log.info('job-queue', `claimed job ${row.id} (${row.type}): ${row.title}`);
		emitJobEvent({ type: 'job_updated', jobId: row.id, status: row.status });
	}
	return row;
}

/**
 * Update a job's status and optional fields.
 */
export function updateJobStatus(id: string, updates: UpdateJobInput): Job | null {
	const setClauses: string[] = ['updated_at = datetime(\'now\')'];
	const params: Record<string, any> = { $id: id };

	if (updates.status !== undefined) {
		setClauses.push('status = $status');
		params.$status = updates.status;
		if (updates.status === 'running') {
			// No extra timestamp — claimed_at is set on claim
		}
		if (updates.status === 'done' || updates.status === 'failed') {
			setClauses.push('completed_at = datetime(\'now\')');
		}
	}
	if (updates.pr_url !== undefined) { setClauses.push('pr_url = $pr_url'); params.$pr_url = updates.pr_url; }
	if (updates.pr_number !== undefined) { setClauses.push('pr_number = $pr_number'); params.$pr_number = updates.pr_number; }
	if (updates.review_verdict !== undefined) { setClauses.push('review_verdict = $review_verdict'); params.$review_verdict = updates.review_verdict; }
	if (updates.session_id !== undefined) { setClauses.push('session_id = $session_id'); params.$session_id = updates.session_id; }
	if (updates.worktree_path !== undefined) { setClauses.push('worktree_path = $worktree_path'); params.$worktree_path = updates.worktree_path; }
	if (updates.result_summary !== undefined) { setClauses.push('result_summary = $result_summary'); params.$result_summary = updates.result_summary; }
	if (updates.error !== undefined) { setClauses.push('error = $error'); params.$error = updates.error; }
	if (updates.branch !== undefined) { setClauses.push('branch = $branch'); params.$branch = updates.branch; }
	if (updates.review_skill !== undefined) { setClauses.push('review_skill = $review_skill'); params.$review_skill = updates.review_skill; }
	if (updates.loop_count !== undefined) { setClauses.push('loop_count = $loop_count'); params.$loop_count = updates.loop_count; }

	const sql = `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $id RETURNING *`;
	const row = getDb().query(sql).get(params) as Job | null;

	if (row) {
		log.info('job-queue', `updated job ${id}: status=${row.status}`);
		emitJobEvent({ type: 'job_updated', jobId: id, status: row.status });
	}
	return row;
}

/**
 * List jobs with optional filters.
 */
export function getJobs(filters?: { status?: string; type?: string; repo?: string }): Job[] {
	const conditions: string[] = [];
	const params: Record<string, any> = {};

	if (filters?.status) { conditions.push('status = $status'); params.$status = filters.status; }
	if (filters?.type) { conditions.push('type = $type'); params.$type = filters.type; }
	if (filters?.repo) { conditions.push('repo = $repo'); params.$repo = filters.repo; }

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	return getDb().query(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`).all(params) as Job[];
}

/**
 * Get a single job by ID.
 */
export function getJob(id: string): Job | null {
	return getJobQuery().get(id) as Job | null;
}

/**
 * Get the full chain of jobs linked via parent_job_id, starting from any job in the chain.
 * Uses a two-phase approach: find the root via a recursive CTE walking up,
 * then walk down from the root via another recursive CTE.
 * This reduces the query count to 2 regardless of chain depth.
 */
export function getJobChain(id: string): Job[] {
	const db = getDb();

	// Phase 1: Find the root job by walking up the parent chain
	const rootRow = db.query(`
		WITH RECURSIVE ancestors AS (
			SELECT id, parent_job_id FROM jobs WHERE id = ?
			UNION ALL
			SELECT j.id, j.parent_job_id FROM jobs j JOIN ancestors a ON j.id = a.parent_job_id
		)
		SELECT id FROM ancestors WHERE parent_job_id IS NULL LIMIT 1
	`).get(id) as { id: string } | null;

	if (!rootRow) {
		// Fallback: if the CTE finds nothing, just return the single job
		const job = getJob(id);
		return job ? [job] : [];
	}

	// Phase 2: Walk down from the root via recursive CTE
	const chain = db.query(`
		WITH RECURSIVE chain AS (
			SELECT * FROM jobs WHERE id = ?
			UNION ALL
			SELECT j.* FROM jobs j JOIN chain c ON j.parent_job_id = c.id
		)
		SELECT * FROM chain ORDER BY created_at ASC
	`).all(rootRow.id) as Job[];

	return chain;
}

/**
 * Delete a job. Only allows deletion of queued, done, failed, or cancelled jobs.
 */
export function deleteJob(id: string): Job | null {
	const job = getJob(id);
	if (!job) return null;

	const deletableStatuses = ['queued', 'reviewing', 'done', 'failed', 'cancelled'];
	if (!deletableStatuses.includes(job.status)) {
		throw new Error(`Cannot delete job in '${job.status}' status — only queued, reviewing, done, failed, or cancelled jobs can be deleted`);
	}

	const deleted = deleteJobQuery().get(id) as Job | null;
	if (deleted) {
		log.info('job-queue', `deleted job ${id}`);
		emitJobEvent({ type: 'job_deleted', jobId: id });
	}
	return deleted;
}

/**
 * Retry a failed job by resetting its status to queued and incrementing retry_count.
 */
export function retryJob(id: string): Job | null {
	const job = getJob(id);
	if (!job) return null;

	if (job.status !== 'failed') {
		throw new Error(`Cannot retry job in '${job.status}' status — only failed jobs can be retried`);
	}

	if (job.retry_count >= job.max_retries) {
		throw new Error(`Job has exceeded maximum retries (${job.max_retries})`);
	}

	const row = getDb().query(`
		UPDATE jobs
		SET status = 'queued', error = NULL, retry_count = retry_count + 1, updated_at = datetime('now')
		WHERE id = ?
		RETURNING *
	`).get(id) as Job | null;

	if (row) {
		log.info('job-queue', `retried job ${id} (attempt ${row.retry_count}/${row.max_retries})`);
		emitJobEvent({ type: 'job_updated', jobId: id, status: row.status });
	}
	return row;
}
