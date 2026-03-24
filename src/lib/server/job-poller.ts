/**
 * Background poller that claims queued jobs and dispatches them to Pi sessions.
 * Creates git worktrees for isolation and spawns sessions via rpc-manager.
 */
import { claimNextJob, updateJobStatus, getJob, type Job } from './job-queue';
import { buildTaskPrompt, buildTaskFixPrompt, buildReviewPrompt } from './job-prompts';
import { handleCompletion } from './job-completion';
import { createSession, sendMessage, subscribe } from './rpc-manager';
import { log } from './logger';
import { join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';

// --- Constants ---

const POLL_INTERVAL_MS = 30_000;
const WORKTREE_BASE = process.env.PI_WORKTREE_DIR || join(process.cwd(), '.worktrees');

/** Patterns for extracting result markers from assistant text. */
const PR_URL_PATTERN = /PR_URL:\s*(\S+)/;
const VERDICT_PATTERN = /VERDICT:\s*(approved|changes_requested)/;

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/** Active session subscriptions keyed by job ID — used to unsubscribe on cleanup. */
const sessionUnsubscribers = new Map<string, () => void>();

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

/** Maximum number of jobs to dispatch in a single poll iteration. */
const MAX_CONCURRENT_CLAIMS = 10;

/**
 * Run a single poll iteration. Claims and dispatches all available queued jobs
 * (up to MAX_CONCURRENT_CLAIMS). Exported for testing and manual trigger.
 */
export async function pollOnce(): Promise<void> {
	if (isPolling) {
		log.info('job-poller', 'skipping poll — previous iteration still running');
		return;
	}

	isPolling = true;
	try {
		let dispatched = 0;
		while (dispatched < MAX_CONCURRENT_CLAIMS) {
			const job = claimNextJob();
			if (!job) break; // No more queued jobs

			await dispatchJob(job);
			dispatched++;
		}
	} catch (err) {
		log.error('job-poller', `poll error: ${err}`);
	} finally {
		isPolling = false;
	}
}

// --- Job dispatch ---

/**
 * Set up a worktree (for task jobs), create a Pi session, and send the
 * appropriate prompt. Review jobs run in the repo's main cwd — they only
 * need to read the PR diff, not modify files.
 */
async function dispatchJob(job: Job): Promise<void> {
	let worktreePath: string | null = null;

	try {
		// Determine the repository path
		const repoPath = job.repo;
		if (!repoPath || !existsSync(repoPath)) {
			throw new Error(`Repository path not found: ${repoPath}`);
		}

		let sessionCwd: string;

		if (job.type === 'review') {
			// Reviews run in the repo's main cwd — no worktree needed
			sessionCwd = repoPath;
			updateJobStatus(job.id, { status: 'running' });
		} else {
			// Task jobs get an isolated worktree
			worktreePath = createWorktree(repoPath, job);
			sessionCwd = worktreePath;
			updateJobStatus(job.id, {
				status: 'running',
				worktree_path: worktreePath,
			});
		}

		// Create a Pi session in the appropriate directory
		const sessionId = await createSession(sessionCwd);

		// Update job with session ID
		updateJobStatus(job.id, { session_id: sessionId });

		// Subscribe to session events so we can detect agent_end and trigger
		// job completion server-side — the extension callback is a fallback.
		subscribeToJobSession(job.id, sessionId);

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

// --- Session subscription for server-side job completion ---

/**
 * Subscribe to a job's Pi session to detect agent_end events.
 * When the agent finishes, we extract result markers from the last assistant
 * message and call handleCompletion directly — no reliance on the extension.
 */
function subscribeToJobSession(jobId: string, sessionId: string): void {
	// Accumulated assistant text across all messages in the session
	let fullAssistantText = '';

	const unsubscribe = subscribe(sessionId, (event: any) => {
		// Accumulate assistant text deltas so we have the full conversation
		if (event.type === 'message_update') {
			const ame = event.assistantMessageEvent;
			if (ame?.type === 'text_delta') {
				fullAssistantText += ame.delta;
			}
		}

		if (event.type === 'agent_end') {
			// Include any text captured in _lastAssistantText (the final message)
			const lastText = event._lastAssistantText ?? '';
			const combinedText = fullAssistantText + '\n' + lastText;

			handleJobAgentEnd(jobId, combinedText);
			cleanupSubscription(jobId);
		}

		if (event.type === 'session_ended') {
			// Session ended without agent_end — treat as completion
			handleJobAgentEnd(jobId, fullAssistantText);
			cleanupSubscription(jobId);
		}
	});

	sessionUnsubscribers.set(jobId, unsubscribe);
}

/**
 * Remove the session subscription for a job.
 */
function cleanupSubscription(jobId: string): void {
	const unsubscribe = sessionUnsubscribers.get(jobId);
	if (unsubscribe) {
		unsubscribe();
		sessionUnsubscribers.delete(jobId);
	}
}

/**
 * Handle agent_end for a job session. Extracts PR_URL and VERDICT from the
 * accumulated assistant text and calls handleCompletion.
 *
 * Guards against double-completion — if the extension callback already
 * completed the job, this is a no-op.
 */
export function handleJobAgentEnd(jobId: string, assistantText: string): void {
	try {
		// Re-fetch the job to check current status — the extension callback
		// may have already completed it.
		const job = getJob(jobId);
		if (!job) {
			log.warn('job-poller', `agent_end for unknown job ${jobId}`);
			return;
		}

		if (job.status !== 'running' && job.status !== 'claimed') {
			log.info('job-poller', `agent_end for job ${jobId} but status is already '${job.status}' — skipping (likely handled by extension callback)`);
			return;
		}

		// Extract result markers from assistant text
		const prUrlMatch = assistantText.match(PR_URL_PATTERN);
		const verdictMatch = assistantText.match(VERDICT_PATTERN);

		log.info('job-poller', `agent_end for job ${jobId} — prUrl=${prUrlMatch?.[1] ?? 'none'}, verdict=${verdictMatch?.[1] ?? 'none'}`);

		handleCompletion(jobId, {
			jobId,
			status: 'done',
			prUrl: prUrlMatch?.[1],
			verdict: verdictMatch?.[1] as 'approved' | 'changes_requested' | undefined,
		});
	} catch (err) {
		log.error('job-poller', `failed to handle agent_end for job ${jobId}: ${err}`);
	}
}

// --- Input validation ---

/** Safe pattern for git ref names (branches, tags). Rejects shell metacharacters. */
const SAFE_GIT_REF_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Validate that a string is safe to use as a git ref name.
 * Prevents command injection by rejecting shell metacharacters.
 */
function validateGitRef(value: string, label: string): void {
	if (!SAFE_GIT_REF_PATTERN.test(value)) {
		throw new Error(`Invalid ${label}: "${value}" — only alphanumeric, dots, hyphens, underscores, and slashes are allowed`);
	}
}

// --- Worktree management ---

/**
 * Create a git worktree for the job. Uses the job's branch if specified,
 * otherwise creates a new branch from target_branch.
 *
 * Uses execFileSync (not execSync) to avoid shell injection — arguments are
 * passed as an array, never interpolated into a shell command string.
 */
function createWorktree(repoPath: string, job: Job): string {
	const worktreeName = `job-${job.id}`;
	const worktreePath = join(WORKTREE_BASE, worktreeName);

	const targetBranch = job.target_branch || 'main';
	validateGitRef(targetBranch, 'target branch');
	if (job.branch) validateGitRef(job.branch, 'branch');

	if (existsSync(worktreePath)) {
		// Clean up stale worktree — try git first, fall back to rmSync
		try {
			execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, stdio: 'pipe' });
		} catch {
			try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	}

	if (job.branch) {
		// Use existing branch
		try {
			execFileSync('git', ['worktree', 'add', worktreePath, job.branch], { cwd: repoPath, stdio: 'pipe' });
		} catch {
			// Branch might not exist locally yet — try fetching and creating from remote
			try {
				execFileSync('git', ['fetch', 'origin', job.branch], { cwd: repoPath, stdio: 'pipe' });
				execFileSync('git', ['worktree', 'add', worktreePath, `origin/${job.branch}`], { cwd: repoPath, stdio: 'pipe' });
			} catch {
				// Fall back to creating from target branch
				execFileSync('git', ['worktree', 'add', '-b', job.branch, worktreePath, targetBranch], { cwd: repoPath, stdio: 'pipe' });
			}
		}
	} else {
		// Create a new branch for the job
		const branchName = `job/${job.id}`;
		validateGitRef(branchName, 'auto-generated branch');
		execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, targetBranch], { cwd: repoPath, stdio: 'pipe' });
		// Update job with the auto-generated branch name
		updateJobStatus(job.id, { branch: branchName });
	}

	log.info('job-poller', `created worktree for job ${job.id}: ${worktreePath}`);

	// Install dependencies if a lockfile is present
	installDependencies(worktreePath, job.id);

	return worktreePath;
}

// --- Dependency installation ---

/** Lockfile → installer command mapping (checked in priority order). */
const LOCKFILE_INSTALLERS: Array<{ lockfile: string; command: string; args: string[] }> = [
	{ lockfile: 'bun.lockb', command: 'bun', args: ['install', '--frozen-lockfile'] },
	{ lockfile: 'bun.lock', command: 'bun', args: ['install', '--frozen-lockfile'] },
	{ lockfile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
	{ lockfile: 'yarn.lock', command: 'yarn', args: ['install', '--frozen-lockfile'] },
	{ lockfile: 'package-lock.json', command: 'npm', args: ['ci'] },
];

/**
 * Detect the package manager from lockfiles and run the installer.
 * Skips silently if no lockfile is found.
 */
function installDependencies(worktreePath: string, jobId: string): void {
	for (const { lockfile, command, args } of LOCKFILE_INSTALLERS) {
		if (existsSync(join(worktreePath, lockfile))) {
			try {
				log.info('job-poller', `installing dependencies for job ${jobId}: ${command} ${args.join(' ')}`);
				execFileSync(command, args, {
					cwd: worktreePath,
					stdio: 'pipe',
					timeout: 120_000,
				});
				log.info('job-poller', `dependencies installed for job ${jobId}`);
			} catch (err: any) {
				log.warn('job-poller', `dependency install failed for job ${jobId}: ${err.message}`);
			}
			return; // Only run the first matching installer
		}
	}
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
