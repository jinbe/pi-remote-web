/**
 * Background poller that claims queued jobs and dispatches them to Pi sessions.
 * 
 * Jobs use a single-job review loop model with phase transitions:
 * queued → claimed → running → reviewing → done/failed/cancelled
 */
import { claimNextJob, updateJobStatus, getJob, type Job } from './job-queue';
import { buildTaskPrompt, buildTaskFixPrompt, buildReviewPrompt, buildNudgeVerdictPrompt } from './job-prompts';
import { createSession, sendMessage, subscribe, stopSession, isActive } from './rpc-manager';
import { log } from './logger';
import { getDb } from './cache';
import { existsSync } from 'fs';

// --- Constants ---

const POLL_INTERVAL_MS = 30_000;

/** Patterns for extracting result markers from assistant text. */
const PR_URL_PATTERN = /PR_URL:\s*(\S+)/;
const VERDICT_PATTERN = /VERDICT:\s*(approved|changes_requested)/;

/**
 * Fuzzy fallback patterns for verdict detection when the exact VERDICT marker
 * is missing. Checked in order — first match wins.
 */
const VERDICT_FALLBACK_APPROVED = /\b(?:gh pr review \d+ --approve|LGTM|looks good to merge|approving this PR)\b/i;
const VERDICT_FALLBACK_CHANGES = /\b(?:gh pr review \d+ --request-changes|requesting changes|changes are needed|must fix before merge)\b/i;

/** Pattern for the agent to signal an unrecoverable error and abort the job. */
const ABORT_JOB_PATTERN = /ABORT_JOB:\s*(.+)/;

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/** Active session subscriptions keyed by job ID — used to unsubscribe on cleanup. */
const sessionUnsubscribers = new Map<string, () => void>();

/**
 * Per-job lock to serialise handleJobAgentEnd calls. Prevents race conditions
 * where concurrent agent_end / session_ended events both read the job status
 * before either has written, causing duplicate state transitions (e.g. a
 * spurious nudge after a verdict was already processed).
 */
const jobLocks = new Map<string, Promise<void>>();

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

	// Recover jobs orphaned by a server restart before polling for new work
	recoverOrphanedJobs();

	pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
	log.info('job-poller', `started (interval: ${POLL_INTERVAL_MS}ms)`);

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
		// Reset to queued — clear claimed_at so dispatch starts fresh
		getDb().query(`
			UPDATE jobs
			SET status = 'queued', claimed_at = NULL, updated_at = datetime('now')
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
 * Create a Pi session in the repo directory and send the prompt.
 */
async function dispatchJob(job: Job): Promise<void> {
	const isReview = job.type === 'review';

	try {
		const repoPath = job.repo;
		if (!repoPath || !existsSync(repoPath)) {
			throw new Error(`Repository path not found: ${repoPath}`);
		}

		const sessionCwd = repoPath;

		updateJobStatus(job.id, { status: 'running' });

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
 * - running (task job) → reviewing: extract PR_URL, stop session, wait for manual done
 * - running (task job, max_loops > 0) → reviewing: extract PR_URL, send review prompt
 * - reviewing → done (approved): cleanup
 * - reviewing → running (changes_requested): send fix prompt or done if loop cap reached
 */
export async function handleJobAgentEnd(jobId: string, assistantText: string): Promise<void> {
	// Serialise concurrent calls for the same job to prevent race conditions
	const prev = jobLocks.get(jobId) ?? Promise.resolve();
	const current = prev.then(() => _handleJobAgentEndInner(jobId, assistantText));
	jobLocks.set(jobId, current.catch(() => {}));
	return current;
}

async function _handleJobAgentEndInner(jobId: string, assistantText: string): Promise<void> {
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

		// Check for agent-initiated abort — only honoured during nudge retries
		// (the agent is only told about ABORT_JOB in the nudge prompt, so we
		// ignore it in normal runs to avoid false positives).
		const abortMatch = job.no_verdict_retries > 0
			? assistantText.match(ABORT_JOB_PATTERN)
			: null;

		log.info('job-poller', `agent_end for job ${jobId} (status=${job.status}) — prUrl=${prUrlMatch?.[1] ?? 'none'}, verdict=${verdictMatch?.[1] ?? 'none'}, abort=${abortMatch ? 'yes' : 'no'}`);

		// ABORT_JOB short-circuits all state transitions — fail immediately
		if (abortMatch) {
			const reason = abortMatch[1].trim();
			log.warn('job-poller', `job ${jobId} aborted by agent: ${reason}`);
			updateJobStatus(jobId, {
				status: 'failed',
				error: `Aborted by agent: ${reason}`,
			});
			await stopJobSession(job);
			cleanupSubscription(jobId);
			return;
		}

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
					await stopJobSession(job);
					cleanupSubscription(jobId);
					log.info('job-poller', `review job ${jobId} → done (verdict: ${verdict})`);
				} else if (await nudgeForVerdict(job)) {
					// Nudge sent — wait for next agent_end
					return;
				} else {
					log.warn('job-poller', `review job ${jobId} ended without verdict after ${job.no_verdict_retries} nudges — marking as failed`);
					updateJobStatus(jobId, {
						status: 'failed',
						error: `Review ended without VERDICT marker after ${job.no_verdict_retries} retry attempts`,
					});
					await stopJobSession(job);
					cleanupSubscription(jobId);
				}
				return;
			}

			// Task jobs below
			const prUrl = prUrlMatch?.[1];

			// All task jobs transition to reviewing when the agent ends.
			updateJobStatus(jobId, {
				status: 'reviewing',
				pr_url: prUrl,
			});

			// Jobs with review loops (max_loops > 0): send the review prompt
			// to continue the automated review cycle in the same session.
			if (job.max_loops > 0 && job.session_id) {
				try {
					const reviewPrompt = buildReviewPrompt(job);
					await sendMessage(job.session_id, reviewPrompt);
				} catch (err) {
					log.warn('job-poller', `failed to send review prompt for job ${jobId}: ${err}`);
				}
				log.info('job-poller', `job ${jobId} running → reviewing (review loop active)`);
			} else {
				// Fire-and-forget (max_loops=0): stop session.
				// The user will manually review the PR and mark the job as done.
				cleanupSubscription(jobId);
				if (job.session_id) {
					try {
						await stopSession(job.session_id);
						log.info('job-poller', `stopped session ${job.session_id} for fire-and-forget job ${jobId}`);
					} catch (err) {
						log.warn('job-poller', `failed to stop session for job ${jobId}: ${err}`);
					}
				}
				log.info('job-poller', `job ${jobId} running → reviewing (fire-and-forget, awaiting manual done)`);
			}
			
		} else if (job.status === 'reviewing') {
			// Fire-and-forget jobs (max_loops=0) never have automated reviewing → done transitions.
			// The user manually reviews the PR and marks the job done via the dashboard.
			if (job.max_loops === 0) {
				log.info('job-poller', `agent_end for fire-and-forget job ${jobId} in reviewing — ignoring (manual review only)`);
				return;
			}

			// Review phase complete → check verdict (exact match first, then fuzzy fallback)
			const verdict = extractVerdict(assistantText, verdictMatch);
			
			if (verdict === 'approved') {
				// Review approved → done
				updateJobStatus(jobId, {
					status: 'done',
					review_verdict: 'approved',
				});

				await stopJobSession(job);
				cleanupSubscription(jobId);
				
				log.info('job-poller', `job ${jobId} approved → done`);
				
			} else if (verdict === 'changes_requested') {
				const nextLoopCount = job.loop_count + 1;
				
				if (nextLoopCount >= job.max_loops) {
					// Loop cap reached → done
					updateJobStatus(jobId, {
						status: 'done',
						review_verdict: 'changes_requested',
						result_summary: (job.result_summary ?? '') + '\n[Loop cap reached — review requested changes but no more fix iterations allowed]',
					});

					await stopJobSession(job);
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
			} else if (await nudgeForVerdict(job)) {
				// Nudge sent — wait for next agent_end
			} else {
				// No verdict found and nudges exhausted — treat as failure
				log.warn('job-poller', `job ${jobId} review phase ended without verdict after ${job.no_verdict_retries} nudges — marking as failed`);
				updateJobStatus(jobId, {
					status: 'failed',
					error: `Review phase ended without VERDICT marker after ${job.no_verdict_retries} retry attempts`,
				});
				await stopJobSession(job);
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

		const failedJob = getJob(jobId);
		if (failedJob) {
			await stopJobSession(failedJob);
		}
		cleanupSubscription(jobId);
	}
}

/**
 * Nudge a stalled job by sending a follow-up prompt asking the agent to
 * provide a VERDICT. Returns true if a nudge was sent (still has retries),
 * false if retries are exhausted.
 */
async function nudgeForVerdict(job: Job): Promise<boolean> {
	const nextRetry = job.no_verdict_retries + 1;
	if (nextRetry > job.max_no_verdict_retries) {
		return false;
	}

	if (!job.session_id) {
		log.warn('job-poller', `cannot nudge job ${job.id} — no session_id`);
		return false;
	}

	try {
		// Check the session is still alive before nudging
		if (!isActive(job.session_id)) {
			log.warn('job-poller', `cannot nudge job ${job.id} — session ${job.session_id} is no longer active`);
			return false;
		}

		updateJobStatus(job.id, { no_verdict_retries: nextRetry });

		const nudgePrompt = buildNudgeVerdictPrompt(job, nextRetry);
		await sendMessage(job.session_id, nudgePrompt);

		log.info('job-poller', `nudged job ${job.id} for verdict (attempt ${nextRetry}/${job.max_no_verdict_retries})`);
		return true;
	} catch (err) {
		log.warn('job-poller', `failed to nudge job ${job.id}: ${err}`);
		return false;
	}
}

/**
 * Stop the Pi session associated with a job.
 */
async function stopJobSession(job: Job): Promise<void> {
	if (!job.session_id) return;
	try {
		await stopSession(job.session_id);
		log.info('job-poller', `stopped session ${job.session_id} for job ${job.id}`);
	} catch (err) {
		log.warn('job-poller', `failed to stop session ${job.session_id}: ${err}`);
	}
}


