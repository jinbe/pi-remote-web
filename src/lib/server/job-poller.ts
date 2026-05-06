/**
 * Background poller that claims queued jobs and dispatches them to Pi sessions.
 * 
 * Jobs use a single-job review loop model with phase transitions:
 * queued → claimed → running → reviewing → done/failed/cancelled
 */
import { claimNextJob, updateJobStatus, getJob, type Job } from './job-queue';
import { buildTaskPrompt, buildTaskFixPrompt, buildReviewPrompt, buildNudgeVerdictPrompt } from './job-prompts';
import { createSession, sendMessage, stopSession, isActive, getHarness, type HarnessType } from './rpc-manager';
import { analyzePr } from './pr-analysis';
import { log } from './logger';
import { getDb } from './cache';
import { existsSync } from 'fs';
import { arePrChecksReady } from './gh-utils';
import { getTask, transitionStage, updateTask, type Task } from './task-queue';
import { getWorktree } from './worktree-manager';
import {
	buildPromptForStage,
	resumeDevForInternalFix,
	spawnInternalReviewJob,
	type StageKind,
} from './task-orchestrator';
import { BRANCH_PUSHED_PATTERN, FIX_PUSHED_PATTERN, ABORT_TASK_PATTERN, TRIAGE_PLAN_PATTERN } from './task-prompts';

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

/** Pattern for the agent to signal that gh pr review submission failed. */
const REVIEW_SUBMIT_FAILED_PATTERN = /REVIEW_SUBMIT_FAILED:\s*(.+)/;

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

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

			// Gate: jobs with a PR must wait for all CI checks to pass before dispatch
			if (job.pr_url && !job.skip_ci_checks) {
				const ciStatus = await arePrChecksReady(job.pr_url);
				if (!ciStatus.ready) {
					// Re-queue the job so it gets picked up in a later poll cycle
					getDb().query(`
						UPDATE jobs
						SET status = 'queued', claimed_at = NULL, updated_at = datetime('now')
						WHERE id = ? AND status = 'claimed'
					`).run(job.id);
					log.info('job-poller', `re-queued job ${job.id} — CI not ready: ${ciStatus.reason}`);
					dispatched++;
					continue;
				}
			}

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
	// Task-system jobs (stage_kind set) take the task-aware path. Legacy/orphan
	// jobs (stage_kind NULL) fall through to the original task/review dispatch.
	if (job.stage_kind) {
		await dispatchTaskJob(job);
		return;
	}

	const isReview = job.type === 'review';

	try {
		const repoPath = job.repo;
		if (!repoPath || !existsSync(repoPath)) {
			throw new Error(`Repository path not found: ${repoPath}`);
		}

		const sessionCwd = repoPath;
		const jobHarness = (job.harness as HarnessType) || getHarness();

		updateJobStatus(job.id, { status: 'running' });

		// Pre-analyze the PR for review jobs to produce tailored review instructions
		let analysis: Awaited<ReturnType<typeof analyzePr>> = null;
		if (isReview && job.pr_url) {
			try {
				analysis = await analyzePr(job.pr_url, jobHarness);
				if (analysis) {
					log.info('job-poller', `PR analysis complete for job ${job.id}`);
				}
			} catch (err) {
				log.warn('job-poller', `PR analysis failed for job ${job.id}, proceeding without: ${err}`);
			}
		}

		// Review sessions use lean flags to skip unnecessary startup overhead
		const extraArgs = isReview ? leanFlagsForHarness(jobHarness) : [];

		const sessionId = await createSession(sessionCwd, job.model ?? undefined, jobHarness, extraArgs);

		// Update job with session ID
		updateJobStatus(job.id, { session_id: sessionId });

		// Send the appropriate prompt
		const prompt = isReview
			? buildReviewPrompt(job, jobHarness, analysis ?? undefined)
			: buildTaskPrompt(job, jobHarness);
		await sendMessage(sessionId, prompt);

		// Persist analysis result and prompt on the job for debugging/auditing
		if (isReview) {
			updateJobStatus(job.id, {
				analysis_json: analysis?.classification ? JSON.stringify(analysis.classification) : undefined,
				review_prompt: prompt,
			});
		}

		log.info('job-poller', `dispatched ${isReview ? 'review' : 'task'} job ${job.id} → session ${sessionId}`);
	} catch (err: any) {
		log.error('job-poller', `failed to dispatch job ${job.id}: ${err.message}`);
		updateJobStatus(job.id, {
			status: 'failed',
			error: `Dispatch failed: ${err.message}`,
		});
	}
}

/**
 * Dispatch a task-system job (stage_kind set). Reads the linked task + worktree,
 * builds the stage-specific prompt, opens a session in the worktree dir, and sends.
 *
 * For dev jobs the session id is also persisted on the task as current_session_id
 * so subsequent fix loops can resume the same agent session.
 */
async function dispatchTaskJob(job: Job): Promise<void> {
	try {
		if (!job.task_id || !job.stage_kind) {
			throw new Error(`task-job ${job.id} missing task_id or stage_kind`);
		}
		const task = getTask(job.task_id);
		if (!task) throw new Error(`task ${job.task_id} not found for job ${job.id}`);
		const wt = getWorktree(task.worktree_id);
		if (!wt) throw new Error(`worktree ${task.worktree_id} not found`);
		if (!existsSync(wt.dir_path)) throw new Error(`worktree dir missing: ${wt.dir_path}`);

		const harness = (job.harness as HarnessType) || getHarness();
		const extraArgs = job.stage_kind === 'internal_review' || job.stage_kind === 'triage'
			? leanFlagsForHarness(harness)
			: [];

		updateJobStatus(job.id, { status: 'running' });

		const sessionId = await createSession(wt.dir_path, job.model ?? undefined, harness, extraArgs);
		updateJobStatus(job.id, { session_id: sessionId });
		// Persist the session on the task so the orchestrator can resume it for fix loops.
		updateTask(task.id, { current_session_id: sessionId });

		const prompt = buildPromptForStage(job.stage_kind as StageKind, task, wt);
		await sendMessage(sessionId, prompt);

		log.info('job-poller', `dispatched task-job ${job.id} (${job.stage_kind}) → session ${sessionId}`);
	} catch (err: any) {
		log.error('job-poller', `failed to dispatch task-job ${job.id}: ${err.message}`);
		updateJobStatus(job.id, { status: 'failed', error: `Dispatch failed: ${err.message}` });
		if (job.task_id) {
			try {
				transitionStage(job.task_id, 'failed', { error: `Dispatch failed: ${err.message}` });
			} catch (e) {
				log.warn('job-poller', `failed to transition task ${job.task_id} to failed: ${e}`);
			}
		}
	}
}

/**
 * Return harness-specific flags to strip unnecessary startup overhead
 * for review sessions.
 */
function leanFlagsForHarness(harness: HarnessType): string[] {
	if (harness === 'claude-code') {
		// Note: --bare disables OAuth/keychain auth (requires ANTHROPIC_API_KEY).
		// Omit it so that normal claude login credentials are used.
		return [];
	}
	// pi: strip extensions, skills, templates, themes (keep tools for gh CLI)
	return ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'];
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

		// Task-system jobs route through the task-aware handler.
		if (job.stage_kind && job.task_id) {
			await handleTaskJobAgentEnd(job, assistantText);
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

		const reviewSubmitFailed = assistantText.match(REVIEW_SUBMIT_FAILED_PATTERN);

		log.info('job-poller', `agent_end for job ${jobId} (status=${job.status}) — prUrl=${prUrlMatch?.[1] ?? 'none'}, verdict=${verdictMatch?.[1] ?? 'none'}, abort=${abortMatch ? 'yes' : 'no'}, reviewSubmitFailed=${reviewSubmitFailed ? 'yes' : 'no'}`);

		// ABORT_JOB short-circuits all state transitions — fail immediately
		if (abortMatch) {
			const reason = abortMatch[1].trim();
			log.warn('job-poller', `job ${jobId} aborted by agent: ${reason}`);
			updateJobStatus(jobId, {
				status: 'failed',
				error: `Aborted by agent: ${reason}`,
			});
			await stopJobSession(job);
			return;
		}

		// State machine transitions
		if (job.status === 'running') {

			// Review-type jobs: dispatched with a review prompt, so agent_end
			// means the review is complete. Extract the verdict and finish.
			if (job.type === 'review') {
				// If the agent reported that gh pr review failed, fail the job
				if (reviewSubmitFailed) {
					const reason = reviewSubmitFailed[1].trim();
					log.warn('job-poller', `review job ${jobId} — gh pr review submission failed: ${reason}`);
					updateJobStatus(jobId, {
						status: 'failed',
						error: `Review submission to GitHub failed: ${reason}`,
					});
					await stopJobSession(job);
					return;
				}

				const verdict = extractVerdict(assistantText, verdictMatch);
				if (verdict) {
					updateJobStatus(jobId, {
						status: 'done',
						review_verdict: verdict,
					});
					await stopJobSession(job);
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
					const harness = (job.harness as HarnessType) || getHarness();
					let loopAnalysis: Awaited<ReturnType<typeof analyzePr>> = null;
					if (job.pr_url) {
						try { loopAnalysis = await analyzePr(job.pr_url, harness); } catch (err) {
						log.warn('job-poller', `loop analysis failed for job ${jobId} (${job.pr_url}): ${err}`);
					}
					}
					const reviewPrompt = buildReviewPrompt(job, harness, loopAnalysis ?? undefined);
					await sendMessage(job.session_id, reviewPrompt);
					updateJobStatus(jobId, {
						analysis_json: loopAnalysis?.classification ? JSON.stringify(loopAnalysis.classification) : undefined,
						review_prompt: reviewPrompt,
					});
				} catch (err) {
					log.warn('job-poller', `failed to send review prompt for job ${jobId}: ${err}`);
				}
				log.info('job-poller', `job ${jobId} running → reviewing (review loop active)`);
			} else {
				// Fire-and-forget (max_loops=0): stop session.
				// The user will manually review the PR and mark the job as done.
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

			// If the agent reported that gh pr review failed, fail the job
			if (reviewSubmitFailed) {
				const reason = reviewSubmitFailed[1].trim();
				log.warn('job-poller', `job ${jobId} — gh pr review submission failed during review phase: ${reason}`);
				updateJobStatus(jobId, {
					status: 'failed',
					error: `Review submission to GitHub failed: ${reason}`,
				});
				await stopJobSession(job);
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

		updateJobStatus(job.id, {
			status: 'running',
			no_verdict_retries: nextRetry,
		});

		const nudgePrompt = buildNudgeVerdictPrompt(job, nextRetry);
		await sendMessage(job.session_id, nudgePrompt);

		log.info('job-poller', `nudged job ${job.id} for verdict — status → running (attempt ${nextRetry}/${job.max_no_verdict_retries})`);
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

// --- Task-system agent_end handler ---

/**
 * Handle agent_end for a stage-kind job. Branches on the job's stage_kind and
 * advances the task per the stage's output marker.
 *
 * Stage transitions driven here:
 *   dev (BRANCH_PUSHED)         → spawn internal_review
 *   internal_review (VERDICT)   → approved: store PR_URL, transition to external_review
 *                               → changes_requested: resume dev session with fix prompt
 *   triage (TRIAGE_PLAN)        → transition to awaiting_merge
 *   any (ABORT_TASK)            → fail the task (halts worktree)
 *
 * Planning jobs do NOT transition on agent_end — completion is user-driven via
 * the accept-plan API endpoint.
 */
async function handleTaskJobAgentEnd(job: Job, assistantText: string): Promise<void> {
	if (!job.task_id || !job.stage_kind) return;
	const task = getTask(job.task_id);
	if (!task) {
		log.warn('job-poller', `task-job ${job.id} references missing task ${job.task_id}`);
		return;
	}

	// ABORT_TASK applies to any stage and immediately fails the task.
	const abort = assistantText.match(ABORT_TASK_PATTERN);
	if (abort) {
		const reason = abort[1].trim();
		updateJobStatus(job.id, { status: 'failed', error: `agent abort: ${reason}` });
		await stopJobSession(job);
		try {
			transitionStage(task.id, 'failed', { error: `Agent aborted: ${reason}` });
		} catch (err) {
			log.warn('job-poller', `failed to transition task ${task.id} to failed: ${err}`);
		}
		return;
	}

	switch (job.stage_kind) {
		case 'planning':
			// Planning is user-driven. agent_end here just means the agent paused;
			// we leave the job running for the user to resume the chat.
			log.info('job-poller', `planning job ${job.id} agent_end (user will resume or accept)`);
			return;

		case 'dev': {
			const branchPushed = assistantText.match(BRANCH_PUSHED_PATTERN);
			if (!branchPushed) {
				log.warn('job-poller', `dev job ${job.id} agent_end without BRANCH_PUSHED marker`);
				return;
			}
			const branch = branchPushed[1];
			updateJobStatus(job.id, { status: 'done', result_summary: `Branch pushed: ${branch}` });
			updateTask(task.id, { branch, current_job_id: null });
			transitionStage(task.id, 'internal_review');
			spawnInternalReviewJob(task.id);
			return;
		}

		case 'internal_review': {
			const verdictMatch = assistantText.match(/VERDICT:\s*(approved|changes_requested)/);
			if (!verdictMatch) {
				log.warn('job-poller', `internal_review job ${job.id} agent_end without VERDICT marker`);
				return;
			}
			const verdict = verdictMatch[1] as 'approved' | 'changes_requested';
			updateJobStatus(job.id, { status: 'done', review_verdict: verdict });
			await stopJobSession(job);

			if (verdict === 'approved') {
				const prUrlMatch = assistantText.match(/PR_URL:\s*(\S+)/);
				if (!prUrlMatch) {
					log.warn('job-poller', `internal_review approved but no PR_URL marker — failing task ${task.id}`);
					transitionStage(task.id, 'failed', { error: 'Internal review approved but no PR_URL emitted' });
					return;
				}
				const prUrl = prUrlMatch[1];
				const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
				const prNumber = prNumMatch ? parseInt(prNumMatch[1], 10) : undefined;
				updateTask(task.id, { current_pr_url: prUrl, current_pr_number: prNumber ?? null, current_job_id: null });
				transitionStage(task.id, 'external_review', { pr_url: prUrl, pr_number: prNumber });
			} else {
				// changes_requested: resume dev session with fix prompt
				try {
					await resumeDevForInternalFix(task.id, assistantText);
				} catch (err) {
					log.warn('job-poller', `failed to resume dev for task ${task.id}: ${err}`);
					transitionStage(task.id, 'failed', { error: `Failed to resume dev: ${err}` });
				}
			}
			return;
		}

		case 'triage': {
			const planMatch = assistantText.match(TRIAGE_PLAN_PATTERN);
			if (!planMatch) {
				log.warn('job-poller', `triage job ${job.id} agent_end without TRIAGE_PLAN marker`);
				return;
			}
			updateJobStatus(job.id, { status: 'done', result_summary: 'Triage complete' });
			await stopJobSession(job);
			updateTask(task.id, { triage_plan_json: planMatch[1].trim(), current_job_id: null });
			transitionStage(task.id, 'awaiting_merge');
			return;
		}

		default: {
			const _exhaustive: never = job.stage_kind as never;
			log.warn('job-poller', `unknown stage_kind ${_exhaustive} on job ${job.id}`);
		}
	}
}


