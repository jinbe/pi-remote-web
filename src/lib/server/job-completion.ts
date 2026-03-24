/**
 * Job completion handler — provides cleanup utilities for worktree and session migration.
 * The main completion logic is now in job-poller.ts (handleJobAgentEnd).
 */
import { getJob, updateJobStatus, type Job } from './job-queue';
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
 * Handle job completion callback from the extension (fallback).
 * In the new single-job model, this is only used as a fallback — the primary
 * completion path is through handleJobAgentEnd in job-poller.ts.
 */
export function handleCompletion(jobId: string, payload: CompletionPayload): Job {
	const job = getJob(jobId);
	if (!job) {
		throw new Error(`Job not found: ${jobId}`);
	}

	// If already in a terminal state, ignore
	if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
		log.info('job-completion', `job ${jobId} already in terminal state ${job.status} — ignoring callback`);
		return job;
	}

	// Handle failure
	if (payload.status === 'failed') {
		const updated = updateJobStatus(jobId, {
			status: 'failed',
			error: payload.error ?? 'Job failed without error details',
			result_summary: payload.resultSummary,
		});
		cleanupJob(job);
		log.info('job-completion', `job ${jobId} failed: ${payload.error}`);
		return updated!;
	}

	// Simple done transition — the poller handles the state machine
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
	cleanupJob(job);

	return updatedJob;
}

// --- Cleanup functions (exported for use by job-poller) ---

/**
 * Clean up a job's resources: migrate sessions to repo directory, remove worktree.
 */
export function cleanupJob(job: Job): void {
	migrateWorktreeSessions(job);
	cleanupWorktree(job);
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
