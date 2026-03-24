/**
 * Job completion handler — processes callback results from the Pi extension
 * and applies the task→review→fix loop logic.
 */
import { getJob, updateJobStatus, createJob, type Job } from './job-queue';
import { log } from './logger';
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import { homedir } from 'os';

// --- Types ---

export interface CompletionPayload {
	jobId: string;
	status: 'done' | 'failed';
	prUrl?: string;
	verdict?: 'approved' | 'changes_requested';
	error?: string;
	resultSummary?: string;
}

// --- Main handler ---

/**
 * Handle job completion callback. Validates the job is running,
 * updates result fields, cleans up worktree, and applies loop logic.
 */
export function handleCompletion(jobId: string, payload: CompletionPayload): Job {
	const job = getJob(jobId);
	if (!job) {
		throw new Error(`Job not found: ${jobId}`);
	}

	if (job.status !== 'running' && job.status !== 'claimed') {
		throw new Error(`Job ${jobId} is not running (current status: ${job.status})`);
	}

	// Handle failure
	if (payload.status === 'failed') {
		const updated = updateJobStatus(jobId, {
			status: 'failed',
			error: payload.error ?? 'Job failed without error details',
			result_summary: payload.resultSummary,
		});
		cleanupWorktree(job);
		log.info('job-completion', `job ${jobId} failed: ${payload.error}`);
		return updated!;
	}

	// Update common result fields
	const updates: Parameters<typeof updateJobStatus>[1] = {
		status: 'done',
		result_summary: payload.resultSummary,
	};

	if (payload.prUrl) {
		updates.pr_url = payload.prUrl;
	}

	if (payload.verdict) {
		updates.review_verdict = payload.verdict;
	}

	const updatedJob = updateJobStatus(jobId, updates)!;

	// Clean up worktree now that the job is done
	cleanupWorktree(job);

	// Apply loop logic based on job type and result
	applyLoopLogic(updatedJob, payload);

	return updatedJob;
}

// --- Loop logic ---

/**
 * After a job completes, determine whether to enqueue a follow-up:
 * - Task done → enqueue Review (if loop_count < max_loops)
 * - Review changes_requested → enqueue Task fix (increment loop_count)
 * - Review approved → done, no follow-up
 * - Loop cap reached → done with note
 */
function applyLoopLogic(job: Job, payload: CompletionPayload): void {
	if (job.type === 'task') {
		// Task completed — enqueue a review if we haven't exceeded loop cap
		if (job.loop_count >= job.max_loops) {
			log.info('job-completion', `job ${job.id} reached loop cap (${job.max_loops}) — no review enqueued`);
			updateJobStatus(job.id, {
				result_summary: (job.result_summary ?? '') + '\n[Loop cap reached — skipped automatic review]',
			});
			return;
		}

		const reviewJob = createJob({
			type: 'review',
			title: `Review: ${job.title}`,
			description: `Automatic review for task job ${job.id}`,
			repo: job.repo ?? undefined,
			branch: job.branch ?? undefined,
			target_branch: job.target_branch,
			parent_job_id: job.id,
			loop_count: job.loop_count,
			max_loops: job.max_loops,
			pr_url: payload.prUrl ?? job.pr_url ?? undefined,
			priority: job.priority,
			review_skill: job.review_skill ?? undefined,
		});

		log.info('job-completion', `enqueued review job ${reviewJob.id} for task ${job.id}`);
	} else if (job.type === 'review') {
		if (payload.verdict === 'approved') {
			log.info('job-completion', `review ${job.id} approved — chain complete`);
			return;
		}

		if (payload.verdict === 'changes_requested') {
			const nextLoopCount = job.loop_count + 1;

			if (nextLoopCount >= job.max_loops) {
				log.info('job-completion', `review ${job.id} requested changes but loop cap reached (${job.max_loops})`);
				updateJobStatus(job.id, {
					result_summary: (job.result_summary ?? '') + '\n[Loop cap reached — skipped automatic fix]',
				});
				return;
			}

			const fixJob = createJob({
				type: 'task',
				title: `Fix: ${job.title.replace(/^Review:\s*/, '')}`,
				description: `Fix review comments from review job ${job.id}`,
				repo: job.repo ?? undefined,
				branch: job.branch ?? undefined,
				target_branch: job.target_branch,
				parent_job_id: job.id,
				loop_count: nextLoopCount,
				max_loops: job.max_loops,
				pr_url: job.pr_url ?? undefined,
				priority: job.priority,
				review_skill: job.review_skill ?? undefined,
			});

			log.info('job-completion', `enqueued fix job ${fixJob.id} for review ${job.id} (loop ${nextLoopCount}/${job.max_loops})`);
		}
	}
}

// --- Session migration ---

const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions');

/**
 * Convert a cwd path to the session directory name pi uses.
 * Mirrors pi's internal convention: `--path-parts--`
 * Exported for testing.
 */
export function cwdToSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Copy session files from the worktree's session directory to the repo's
 * session directory so they appear under the correct project in the dashboard.
 */
function migrateWorktreeSessions(job: Job): void {
	if (!job.worktree_path || !job.repo) return;

	const worktreeSessionDir = join(SESSIONS_DIR, cwdToSessionDirName(resolve(job.worktree_path)));
	const repoSessionDir = join(SESSIONS_DIR, cwdToSessionDirName(resolve(job.repo)));

	if (!existsSync(worktreeSessionDir)) {
		log.info('job-completion', `no worktree session dir to migrate: ${worktreeSessionDir}`);
		return;
	}

	try {
		mkdirSync(repoSessionDir, { recursive: true });

		const files = readdirSync(worktreeSessionDir).filter(f => f.endsWith('.jsonl'));
		for (const file of files) {
			const src = join(worktreeSessionDir, file);
			const dest = join(repoSessionDir, file);
			copyFileSync(src, dest);
		}

		log.info('job-completion', `migrated ${files.length} session file(s) from worktree to repo: ${repoSessionDir}`);

		// Remove the worktree session directory
		rmSync(worktreeSessionDir, { recursive: true, force: true });
		log.info('job-completion', `removed worktree session dir: ${worktreeSessionDir}`);
	} catch (err) {
		log.warn('job-completion', `failed to migrate worktree sessions: ${err}`);
	}
}

// --- Worktree cleanup ---

/**
 * Migrate session files to the repo's session directory, then remove the
 * git worktree using `git worktree remove` to properly unregister it from
 * git's tracking. Falls back to rmSync if git fails.
 */
function cleanupWorktree(job: Job): void {
	if (!job.worktree_path) return;

	// Copy session files to repo's session directory before cleanup
	migrateWorktreeSessions(job);

	// Try git worktree remove first (uses repo path if available)
	try {
		if (job.repo) {
			execFileSync('git', ['worktree', 'remove', '--force', job.worktree_path], {
				cwd: job.repo,
				stdio: 'pipe',
			});
			log.info('job-completion', `removed worktree via git: ${job.worktree_path}`);
			return;
		}
	} catch (err) {
		log.warn('job-completion', `git worktree remove failed, falling back to rmSync: ${err}`);
	}

	// Fallback: remove the directory directly
	try {
		rmSync(job.worktree_path, { recursive: true, force: true });
		log.info('job-completion', `cleaned up worktree via rmSync: ${job.worktree_path}`);
	} catch (err) {
		log.warn('job-completion', `failed to clean up worktree ${job.worktree_path}: ${err}`);
	}
}
