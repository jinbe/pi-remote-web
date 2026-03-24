/**
 * Background poller that claims queued jobs and dispatches them to Pi sessions.
 * Creates git worktrees for isolation and spawns sessions via rpc-manager.
 */
import { claimNextJob, updateJobStatus, type Job } from './job-queue';
import { buildTaskPrompt, buildTaskFixPrompt, buildReviewPrompt } from './job-prompts';
import { createSession, sendMessage } from './rpc-manager';
import { log } from './logger';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// --- Constants ---

const POLL_INTERVAL_MS = 30_000;
const WORKTREE_BASE = process.env.PI_WORKTREE_DIR || join(homedir(), '.pi', 'worktrees');

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// --- Public API ---

/**
 * Start the background poller. Polls every 30 seconds for queued jobs.
 */
export function start(): void {
	if (pollTimer) {
		log.info('job-poller', 'poller already running');
		return;
	}

	// Ensure worktree base directory exists
	try { mkdirSync(WORKTREE_BASE, { recursive: true }); } catch { /* already exists */ }

	pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
	log.info('job-poller', `started (interval: ${POLL_INTERVAL_MS}ms, worktree dir: ${WORKTREE_BASE})`);

	// Run an immediate poll on start
	pollOnce();
}

/**
 * Stop the background poller.
 */
export function stop(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
		log.info('job-poller', 'stopped');
	}
}

/**
 * Check whether the poller is currently active.
 */
export function isRunning(): boolean {
	return pollTimer !== null;
}

/**
 * Run a single poll iteration. Claims the next job and dispatches it.
 * Exported for testing and manual trigger.
 */
export async function pollOnce(): Promise<void> {
	if (isPolling) {
		log.info('job-poller', 'skipping poll — previous iteration still running');
		return;
	}

	isPolling = true;
	try {
		const job = claimNextJob();
		if (!job) return; // Nothing queued

		await dispatchJob(job);
	} catch (err) {
		log.error('job-poller', `poll error: ${err}`);
	} finally {
		isPolling = false;
	}
}

// --- Job dispatch ---

/**
 * Set up a worktree, create a Pi session, and send the appropriate prompt.
 */
async function dispatchJob(job: Job): Promise<void> {
	let worktreePath: string | null = null;

	try {
		// Determine the repository path
		const repoPath = job.repo;
		if (!repoPath || !existsSync(repoPath)) {
			throw new Error(`Repository path not found: ${repoPath}`);
		}

		// Create a worktree for isolation
		worktreePath = createWorktree(repoPath, job);

		// Update job with worktree path and mark as running
		updateJobStatus(job.id, {
			status: 'running',
			worktree_path: worktreePath,
		});

		// Create a Pi session in the worktree directory
		const sessionId = await createSession(worktreePath);

		// Update job with session ID
		updateJobStatus(job.id, { session_id: sessionId });

		// Build and send the appropriate prompt
		const prompt = buildPromptForJob(job);
		await sendMessage(sessionId, prompt);

		log.info('job-poller', `dispatched job ${job.id} (${job.type}) → session ${sessionId}`);
	} catch (err: any) {
		log.error('job-poller', `failed to dispatch job ${job.id}: ${err.message}`);
		updateJobStatus(job.id, {
			status: 'failed',
			error: `Dispatch failed: ${err.message}`,
			worktree_path: worktreePath ?? undefined,
		});
	}
}

// --- Worktree management ---

/**
 * Create a git worktree for the job. Uses the job's branch if specified,
 * otherwise creates a new branch from target_branch.
 */
function createWorktree(repoPath: string, job: Job): string {
	const worktreeName = `job-${job.id}`;
	const worktreePath = join(WORKTREE_BASE, worktreeName);

	if (existsSync(worktreePath)) {
		// Clean up stale worktree
		try {
			execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' });
		} catch {
			// May not be registered as a worktree — just remove the directory
			try { execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe' }); } catch { /* best effort */ }
		}
	}

	const targetBranch = job.target_branch || 'main';

	if (job.branch) {
		// Use existing branch
		try {
			execSync(`git worktree add "${worktreePath}" "${job.branch}"`, { cwd: repoPath, stdio: 'pipe' });
		} catch {
			// Branch might not exist locally yet — try fetching and creating from remote
			try {
				execSync(`git fetch origin ${job.branch}`, { cwd: repoPath, stdio: 'pipe' });
				execSync(`git worktree add "${worktreePath}" "origin/${job.branch}"`, { cwd: repoPath, stdio: 'pipe' });
			} catch {
				// Fall back to creating from target branch
				execSync(`git worktree add -b "${job.branch}" "${worktreePath}" "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
			}
		}
	} else {
		// Create a new branch for the job
		const branchName = `job/${job.id}`;
		execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${targetBranch}"`, { cwd: repoPath, stdio: 'pipe' });
		// Update job with the auto-generated branch name
		updateJobStatus(job.id, { branch: branchName });
	}

	log.info('job-poller', `created worktree for job ${job.id}: ${worktreePath}`);
	return worktreePath;
}

// --- Prompt building ---

/**
 * Build the correct prompt based on the job type and context.
 */
function buildPromptForJob(job: Job): string {
	if (job.type === 'review') {
		return buildReviewPrompt(job);
	}

	// Task job — determine if this is a fix (has parent review) or new work
	if (job.parent_job_id && job.loop_count > 0) {
		// This is a fix iteration — the description should contain review comments
		return buildTaskFixPrompt(job, job.description ?? 'Address the review comments.');
	}

	return buildTaskPrompt(job);
}
