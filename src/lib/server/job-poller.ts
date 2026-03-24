/**
 * Background poller that claims queued jobs and dispatches them to Pi sessions.
 * Creates git worktrees for isolation and spawns sessions via rpc-manager.
 * 
 * Jobs now use a single-job review loop model with phase transitions:
 * queued → claimed → running → reviewing → done/failed/cancelled
 */
import { claimNextJob, updateJobStatus, getJob, type Job } from './job-queue';
import { buildTaskPrompt, buildTaskFixPrompt, buildReviewPrompt } from './job-prompts';
import { cleanupJob } from './job-completion';
import { createSession, sendMessage, subscribe, stopSession, isActive } from './rpc-manager';
import { log } from './logger';
import { getDb } from './cache';
import { join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';

// --- Constants ---

const POLL_INTERVAL_MS = 30_000;
const WORKTREE_BASE = process.env.PI_WORKTREE_DIR || join(process.cwd(), '.worktrees');

/** Patterns for extracting result markers from assistant text. */
const PR_URL_PATTERN = /PR_URL:\s*(\S+)/;
const VERDICT_PATTERN = /VERDICT:\s*(approved|changes_requested)/;

/**
 * Fuzzy fallback patterns for verdict detection when the exact VERDICT marker
 * is missing. Checked in order — first match wins.
 */
const VERDICT_FALLBACK_APPROVED = /\b(?:gh pr review \d+ --approve|LGTM|looks good to merge|approving this PR)\b/i;
const VERDICT_FALLBACK_CHANGES = /\b(?:gh pr review \d+ --request-changes|requesting changes|changes are needed|must fix before merge)\b/i;

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/** Active session subscriptions keyed by job ID — used to unsubscribe on cleanup. */
const sessionUnsubscribers = new Map<string, () => void>();

// --- Public API ---

/**
 * Start the background poller. Polls every 30 seconds for queued jobs.
 * On startup, recovers orphaned jobs that were mid-dispatch when the server
 * last restarted.
 */
export function start(): void {
	if (pollTimer) {
		log.info('job-poller', 'poller already running');
		return;
	}

	// Ensure worktree base directory exists
	try { mkdirSync(WORKTREE_BASE, { recursive: true }); } catch { /* already exists */ }

	// Recover jobs orphaned by a server restart before polling for new work
	recoverOrphanedJobs();

	pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
	log.info('job-poller', `started (interval: ${POLL_INTERVAL_MS}ms, worktree dir: ${WORKTREE_BASE})`);

	// Run an immediate poll on start (fire-and-forget — runs async)
	setTimeout(() => pollOnce(), 0);
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
 * Reset internal state for testing. Clears the `isPolling` guard so tests
 * can call `pollOnce()` reliably after `stop()`.
 */
export function _resetForTesting(): void {
	isPolling = false;
}

/**
 * Check whether the poller is currently active.
 */
export function isRunning(): boolean {
	return pollTimer !== null;
}

// --- Orphaned job recovery ---

/**
 * Recover jobs that were orphaned by a server restart.
 *
 * A job is orphaned if it's in 'claimed' or 'running' status but has no active
 * session — this means the server died mid-dispatch before the session was
 * created or registered. Re-queue these so the next poll picks them up.
 *
 * For 'running' jobs that DO have a session_id, the session recovery in
 * rpc-manager handles reconnection — we only touch sessionless jobs here.
 */
export function recoverOrphanedJobs(): void {
	const orphaned = getDb().query(
		`SELECT * FROM jobs WHERE status IN ('claimed', 'running') AND session_id IS NULL`
	).all() as Job[];

	for (const job of orphaned) {
		// Clean up any partial worktree that was created before the crash
		if (job.worktree_path) {
			try {
				cleanupJob(job);
			} catch (err) {
				log.warn('job-poller', `failed to clean up orphaned worktree for job ${job.id}: ${err}`);
			}
		}

		// Clean up stale auto-generated branch (job/<id>) if it exists
		if (!job.branch && job.repo) {
			const staleBranch = `job/${job.id}`;
			try {
				execFileSync('git', ['branch', '-D', staleBranch], { cwd: job.repo, stdio: 'pipe' });
				log.info('job-poller', `deleted stale branch ${staleBranch} during recovery`);
			} catch { /* branch doesn't exist — fine */ }
		}

		// Reset to queued — clear claimed_at, worktree_path, and branch so dispatch starts fresh
		getDb().query(`
			UPDATE jobs
			SET status = 'queued', claimed_at = NULL, worktree_path = NULL, branch = NULL, updated_at = datetime('now')
			WHERE id = ?
		`).run(job.id);
		log.info('job-poller', `recovered orphaned job ${job.id} (was ${job.status}) → re-queued`);
	}

	if (orphaned.length > 0) {
		log.info('job-poller', `recovered ${orphaned.length} orphaned job(s)`);
	}
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
 * Set up a worktree (for task jobs), create a Pi session, and send the prompt.
 * Review jobs skip the worktree — they only need to read the PR diff via `gh`.
 */
async function dispatchJob(job: Job): Promise<void> {
	let worktreePath: string | null = null;
	const isReview = job.type === 'review';

	try {
		const repoPath = job.repo;
		if (!repoPath || !existsSync(repoPath)) {
			throw new Error(`Repository path not found: ${repoPath}`);
		}

		let sessionCwd: string;

		if (isReview) {
			// Review jobs run directly in the repo — no worktree needed
			sessionCwd = repoPath;
		} else {
			// Task jobs get an isolated worktree
			worktreePath = createWorktree(repoPath, job);
			sessionCwd = worktreePath;
		}

		updateJobStatus(job.id, {
			status: 'running',
			worktree_path: worktreePath ?? undefined,
		});

		// Create a Pi session (with optional model override)
		const sessionId = await createSession(sessionCwd, job.model ?? undefined);

		// Update job with session ID
		updateJobStatus(job.id, { session_id: sessionId });

		// Subscribe to session events so we can detect agent_end and trigger
		// phase transitions server-side — the extension callback is a fallback.
		subscribeToJobSession(job.id, sessionId);

		// Send the appropriate prompt
		const prompt = isReview ? buildReviewPrompt(job) : buildTaskPrompt(job);
		await sendMessage(sessionId, prompt);

		log.info('job-poller', `dispatched ${isReview ? 'review' : 'task'} job ${job.id} → session ${sessionId}`);
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
 * The subscription persists through all phase transitions (task → review → fix)
 * and is only cleaned up when the job reaches a terminal state.
 */
function subscribeToJobSession(jobId: string, sessionId: string): void {
	// Accumulated assistant text for the current phase — reset between phases
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

			// Handle phase transition — don't cleanup subscription yet
			handleJobAgentEnd(jobId, combinedText);
			
			// Reset accumulated text for the next phase
			fullAssistantText = '';
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
 * Extract a verdict from assistant text. Tries the exact VERDICT marker first,
 * then falls back to fuzzy pattern matching.
 */
function extractVerdict(
	assistantText: string,
	exactMatch: RegExpMatchArray | null,
): 'approved' | 'changes_requested' | null {
	if (exactMatch) {
		return exactMatch[1] as 'approved' | 'changes_requested';
	}
	if (VERDICT_FALLBACK_APPROVED.test(assistantText)) return 'approved';
	if (VERDICT_FALLBACK_CHANGES.test(assistantText)) return 'changes_requested';
	return null;
}

/**
 * Handle agent_end for a job session. Implements the state machine:
 * - running (review job) → done: extract verdict directly
 * - running (task job) → reviewing: extract PR_URL, send review prompt
 * - reviewing → done (approved): cleanup
 * - reviewing → running (changes_requested): send fix prompt or done if loop cap reached
 */
export async function handleJobAgentEnd(jobId: string, assistantText: string): Promise<void> {
	try {
		// Re-fetch the job to check current status
		const job = getJob(jobId);
		if (!job) {
			log.warn('job-poller', `agent_end for unknown job ${jobId}`);
			return;
		}

		// Terminal states — no transitions
		if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
			log.info('job-poller', `agent_end for job ${jobId} but status is already '${job.status}' — no action`);
			return;
		}

		// Extract result markers from assistant text
		const prUrlMatch = assistantText.match(PR_URL_PATTERN);
		const verdictMatch = assistantText.match(VERDICT_PATTERN);

		log.info('job-poller', `agent_end for job ${jobId} (status=${job.status}) — prUrl=${prUrlMatch?.[1] ?? 'none'}, verdict=${verdictMatch?.[1] ?? 'none'}`);

		// State machine transitions
		if (job.status === 'running') {

			// Review-type jobs: dispatched with a review prompt, so agent_end
			// means the review is complete. Extract the verdict and finish.
			if (job.type === 'review') {
				const verdict = extractVerdict(assistantText, verdictMatch);
				if (verdict) {
					updateJobStatus(jobId, {
						status: 'done',
						review_verdict: verdict,
					});
					await cleanupJobAfterCompletion(job);
					cleanupSubscription(jobId);
					log.info('job-poller', `review job ${jobId} → done (verdict: ${verdict})`);
				} else {
					log.warn('job-poller', `review job ${jobId} ended without verdict — marking as failed`);
					updateJobStatus(jobId, {
						status: 'failed',
						error: 'Review ended without VERDICT marker',
					});
					await cleanupJobAfterCompletion(job);
					cleanupSubscription(jobId);
				}
				return;
			}

			// Task jobs below
			const prUrl = prUrlMatch?.[1];

			// Fire-and-forget jobs (max_loops=0): having a PR is as good as done —
			// skip the reviewing phase entirely since no verdict check will follow.
			if (job.max_loops === 0 && prUrl) {
				updateJobStatus(jobId, {
					status: 'done',
					pr_url: prUrl,
				});

				await cleanupJobAfterCompletion(job);
				cleanupSubscription(jobId);

				log.info('job-poller', `job ${jobId} fire-and-forget with PR → done, cleaned up`);
				return;
			}

			// Jobs with review loops: transition to reviewing
			updateJobStatus(jobId, {
				status: 'reviewing',
				pr_url: prUrl,
			});

			// Send review prompt if review loop is enabled (max_loops > 0)
			if (job.max_loops > 0 && job.session_id) {
				try {
					const reviewPrompt = buildReviewPrompt(job);
					await sendMessage(job.session_id, reviewPrompt);
				} catch (err) {
					log.warn('job-poller', `failed to send review prompt for job ${jobId}: ${err}`);
				}
			}
			
			log.info('job-poller', `job ${jobId} transitioned running → reviewing`);
			
		} else if (job.status === 'reviewing') {
			// Review phase complete → check verdict (exact match first, then fuzzy fallback)
			const verdict = extractVerdict(assistantText, verdictMatch);
			
			if (verdict === 'approved') {
				// Review approved → done
				updateJobStatus(jobId, {
					status: 'done',
					review_verdict: 'approved',
				});

				// Cleanup: migrate sessions, remove worktree, stop session
				await cleanupJobAfterCompletion(job);
				cleanupSubscription(jobId);
				
				log.info('job-poller', `job ${jobId} approved → done, cleaned up`);
				
			} else if (verdict === 'changes_requested') {
				const nextLoopCount = job.loop_count + 1;
				
				if (nextLoopCount >= job.max_loops) {
					// Loop cap reached → done
					updateJobStatus(jobId, {
						status: 'done',
						review_verdict: 'changes_requested',
						result_summary: (job.result_summary ?? '') + '\n[Loop cap reached — review requested changes but no more fix iterations allowed]',
					});

					await cleanupJobAfterCompletion(job);
					cleanupSubscription(jobId);
					
					log.info('job-poller', `job ${jobId} loop cap reached (${job.max_loops}) → done`);
					
				} else {
					// Send fix prompt to the SAME session
					updateJobStatus(jobId, {
						status: 'running',
						loop_count: nextLoopCount,
						review_verdict: 'changes_requested',
					});

					if (job.session_id) {
						try {
							const fixPrompt = buildTaskFixPrompt(job, assistantText);
							await sendMessage(job.session_id, fixPrompt);
						} catch (err) {
							log.warn('job-poller', `failed to send fix prompt for job ${jobId}: ${err}`);
						}
					}
					
					log.info('job-poller', `job ${jobId} changes_requested → running (loop ${nextLoopCount}/${job.max_loops})`);
				}
			} else {
				// No verdict found — treat as failure
				log.warn('job-poller', `job ${jobId} review phase ended without verdict — marking as failed`);
				updateJobStatus(jobId, {
					status: 'failed',
					error: 'Review phase ended without VERDICT marker',
				});
				await cleanupJobAfterCompletion(job);
				cleanupSubscription(jobId);
			}
		}
	} catch (err) {
		log.error('job-poller', `failed to handle agent_end for job ${jobId}: ${err}`);
		// Mark job as failed
		updateJobStatus(jobId, {
			status: 'failed',
			error: `Phase transition failed: ${err}`,
		});

		// Ensure cleanup still runs — migrate sessions + remove worktree
		const failedJob = getJob(jobId);
		if (failedJob) {
			await cleanupJobAfterCompletion(failedJob);
		}
		cleanupSubscription(jobId);
	}
}

/**
 * Cleanup after a job completes (done/failed/cancelled).
 * Migrates sessions, removes worktree, and stops the session.
 */
async function cleanupJobAfterCompletion(job: Job): Promise<void> {
	try {
		await cleanupJob(job);
		
		// Stop the session if it's still running
		if (job.session_id) {
			try {
				await stopSession(job.session_id);
				log.info('job-poller', `stopped session ${job.session_id} for job ${job.id}`);
			} catch (err) {
				log.warn('job-poller', `failed to stop session ${job.session_id}: ${err}`);
			}
		}
	} catch (err) {
		log.error('job-poller', `cleanup failed for job ${job.id}: ${err}`);
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

		// Delete stale branch from a previous failed dispatch attempt
		try {
			execFileSync('git', ['branch', '-D', branchName], { cwd: repoPath, stdio: 'pipe' });
			log.info('job-poller', `deleted stale branch ${branchName} before recreating`);
		} catch { /* branch doesn't exist — expected for fresh jobs */ }

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
