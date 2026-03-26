/**
 * Job completion handler — provides cleanup utilities for worktree and session migration.
 * The main completion logic (state machine) is in job-poller.ts (handleJobAgentEnd).
 *
 * The extension callback delegates to handleJobAgentEnd so the review loop
 * is respected — it never directly marks a job as done.
 */
import { getJob, updateJobStatus, type Job } from './job-queue';
import { getDb } from './cache';
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
 *
 * The server-side session subscription also calls handleJobAgentEnd on agent_end,
 * so the callback and subscription race. We guard against double-processing:
 * - Terminal states (done/failed/cancelled) are ignored outright.
 * - If the subscription already transitioned the job to the same state the
 *   callback wants (e.g. both want 'reviewing'), we skip the state machine
 *   but still update any missing fields (pr_url, verdict) from the callback.
 */
export async function handleCompletion(jobId: string, payload: CompletionPayload): Promise<Job> {
	// Dynamic import to avoid circular dependency — job-poller imports from us.
	// Cannot use require() because the project is ESM ("type": "module").
	const { handleJobAgentEnd } = await import('./job-poller');

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

	// Guard against the subscription/callback race: if the subscription already
	// moved the job to 'reviewing' and the callback also reports 'reviewing',
	// don't re-run the state machine (which would see the job in 'reviewing'
	// without a VERDICT and either ignore it or mark it as failed). Instead,
	// just patch any missing fields from the callback payload.
	if (job.status === 'reviewing' && payload.status === 'reviewing') {
		const patchUpdates: Record<string, any> = {};
		if (payload.prUrl && !job.pr_url) patchUpdates.pr_url = payload.prUrl;
		if (payload.resultSummary && !job.result_summary) patchUpdates.result_summary = payload.resultSummary;

		if (Object.keys(patchUpdates).length > 0) {
			updateJobStatus(jobId, patchUpdates);
			log.info('job-completion', `job ${jobId} already reviewing — patched fields from callback: ${Object.keys(patchUpdates).join(', ')}`);
		} else {
			log.info('job-completion', `job ${jobId} already reviewing — callback is a no-op`);
		}
		return getJob(jobId) ?? job;
	}

	// Reconstruct the assistant text markers from the callback payload
	// so handleJobAgentEnd can extract them and drive the state machine.
	const markerLines: string[] = [];
	if (payload.prUrl) markerLines.push(`PR_URL: ${payload.prUrl}`);
	if (payload.verdict) markerLines.push(`VERDICT: ${payload.verdict}`);
	if (payload.resultSummary) markerLines.push(payload.resultSummary);
	const syntheticText = markerLines.join('\n');

	// Delegate to the state machine — this handles running → reviewing → done.
	// Await so the state transition completes before we return the updated job.
	await handleJobAgentEnd(jobId, syntheticText);

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

	// Clear worktree_path in the DB so the cache doesn't reference a removed directory
	if (job.worktree_path) {
		updateJobStatus(job.id, { worktree_path: null });
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

		// Purge stale cache entries so the worktree doesn't appear as a project
		const worktreeCwd = resolve(job.worktree_path);
		const db = getDb();
		const staleFiles = db.query('SELECT file_path FROM session_meta WHERE cwd = ?').all(worktreeCwd) as { file_path: string }[];
		if (staleFiles.length > 0) {
			const filePaths = staleFiles.map(r => r.file_path);
			for (const fp of filePaths) {
				db.run('DELETE FROM session_messages WHERE file_path = ?', [fp]);
			}
			db.run('DELETE FROM session_meta WHERE cwd = ?', [worktreeCwd]);
			log.info('job-completion', `purged ${staleFiles.length} stale cache entries for worktree cwd: ${worktreeCwd}`);
		}
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
