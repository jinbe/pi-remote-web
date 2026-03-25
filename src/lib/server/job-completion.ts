/**
 * Job completion handler — provides cleanup utilities for worktree and session migration.
 * The main completion logic (state machine) is in job-poller.ts (handleJobAgentEnd).
 *
 * The extension callback delegates to handleJobAgentEnd so the review loop
 * is respected — it never directly marks a job as done.
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
	status: 'done' | 'failed' | 'reviewing';
	prUrl?: string;
	verdict?: 'approved' | 'changes_requested';
	error?: string;
	resultSummary?: string;
}

// --- Main handler ---

/**
 * Handle job completion callback from the extension.
 * Delegates to the poller's state machine so the review loop is respected.
 *
 * For failures, marks the job as failed directly (no state machine needed).
 * For success, constructs the assistant text markers and lets handleJobAgentEnd
 * drive the state transitions (running → reviewing → done).
 */
export function handleCompletion(jobId: string, payload: CompletionPayload): Job {
	// Lazy import to avoid circular dependency — job-poller imports from us
	const { handleJobAgentEnd } = require('./job-poller');

	const job = getJob(jobId);
	if (!job) {
		throw new Error(`Job not found: ${jobId}`);
	}

	// If already in a terminal state, ignore
	if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
		log.info('job-completion', `job ${jobId} already in terminal state ${job.status} — ignoring callback`);
		return job;
	}

	// Handle failure directly — no state machine needed, but still clean up
	if (payload.status === 'failed') {
		const updated = updateJobStatus(jobId, {
			status: 'failed',
			error: payload.error ?? 'Job failed without error details',
			result_summary: payload.resultSummary,
		});
		log.info('job-completion', `job ${jobId} failed via callback: ${payload.error}`);

		// Still migrate sessions and clean up worktree on failure
		cleanupJob(job);

		return updated!;
	}

	// Reconstruct the assistant text markers from the callback payload
	// so handleJobAgentEnd can extract them and drive the state machine.
	const markerLines: string[] = [];
	if (payload.prUrl) markerLines.push(`PR_URL: ${payload.prUrl}`);
	if (payload.verdict) markerLines.push(`VERDICT: ${payload.verdict}`);
	if (payload.resultSummary) markerLines.push(payload.resultSummary);
	const syntheticText = markerLines.join('\n');

	// Delegate to the state machine — this handles running → reviewing → done
	handleJobAgentEnd(jobId, syntheticText);

	// Return the updated job (state may have changed)
	return getJob(jobId) ?? job;
}

// --- Cleanup functions (exported for use by job-poller) ---

/**
 * Clean up a job's resources: migrate sessions to repo directory, remove worktree.
 * Only call this when the job has reached a terminal state.
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
 * Remove the git worktree using `git worktree remove` to properly unregister
 * it from git's tracking. Falls back to rmSync if git fails.
 */
function cleanupWorktree(job: Job): void {
	if (!job.worktree_path) return;

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
