/**
 * Task-PR poller — for bot-authored task PRs, distinct from the existing
 * github-pr-poller which scans for human-authored PRs to review.
 *
 * Polls open PRs of tasks in `external_review` or `awaiting_merge` stage
 * and reacts to the most-recent unhandled review event:
 *
 *   APPROVED          → spawn triage job (if not already triaged)
 *   CHANGES_REQUESTED → resume dev session with external-fix prompt
 *   COMMENTED         → ignore (per design Q14b)
 *   merged            → handleTaskMerged → advance worktree → next task's dev
 *
 * The poller tracks `last_external_review_id` on each task so it does not
 * re-fire on already-handled reviews. It assumes review ids are
 * monotonically increasing within a PR (true for GitHub).
 */
import { execGh } from './gh-utils';
import { log } from './logger';
import { getDb } from './cache';
import { getTask, updateTask, transitionStage, type Task } from './task-queue';
import { spawnTriageJob, resumeDevForExternalFix, handleTaskMerged } from './task-orchestrator';

const POLL_INTERVAL_MS = 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

interface GhReview {
	id: number;
	state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
	body: string;
	submittedAt: string | null;
	author: { login: string } | null;
}

interface GhPrSummary {
	merged: boolean;
	mergedAt: string | null;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	reviews: GhReview[];
}

export function start(): void {
	if (pollTimer) return;
	pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
	log.info('task-pr-poller', `started (interval: ${POLL_INTERVAL_MS}ms)`);
	setTimeout(() => pollOnce(), 0);
}

export function stop(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
		log.info('task-pr-poller', 'stopped');
	}
}

export function isRunning(): boolean {
	return pollTimer !== null;
}

/**
 * Single poll iteration: select all tasks with an open PR in a relevant stage
 * and process them in parallel (PR queries are independent).
 */
export async function pollOnce(): Promise<void> {
	if (isPolling) return;
	isPolling = true;
	try {
		const tasks = getDb().query(
			`SELECT * FROM tasks
			 WHERE current_pr_url IS NOT NULL
			   AND stage IN ('external_review', 'awaiting_merge')`,
		).all() as Task[];

		await Promise.all(tasks.map(t => processTask(t).catch(err =>
			log.warn('task-pr-poller', `processTask failed for task ${t.id}: ${err}`),
		)));
	} catch (err) {
		log.error('task-pr-poller', `poll error: ${err}`);
	} finally {
		isPolling = false;
	}
}

async function processTask(task: Task): Promise<void> {
	if (!task.current_pr_url || !task.current_pr_number) return;

	const summary = await fetchPrSummary(task.current_pr_url);
	if (!summary) return;

	// Merge always wins, regardless of stage.
	if (summary.merged || summary.state === 'MERGED') {
		log.info('task-pr-poller', `task ${task.id} PR ${task.current_pr_url} merged → advancing`);
		await handleTaskMerged(task.id);
		return;
	}

	if (summary.state === 'CLOSED') {
		// PR closed without merge → user decision; treat as task cancellation rather than failure.
		log.info('task-pr-poller', `task ${task.id} PR closed without merge — cancelling task`);
		try {
			transitionStage(task.id, 'cancelled', { error: 'PR closed without merging' });
		} catch (err) {
			log.warn('task-pr-poller', `failed to cancel task ${task.id}: ${err}`);
		}
		return;
	}

	if (task.stage !== 'external_review') return; // awaiting_merge waits for merge only

	// Only act on the most-recent submitted review with a meaningful state.
	const latest = pickLatestActionableReview(summary.reviews);
	if (!latest) return;

	if (task.last_external_review_id && parseInt(task.last_external_review_id, 10) >= latest.id) {
		// Already handled this review.
		return;
	}

	if (latest.state === 'APPROVED') {
		// Don't double-spawn triage if one already exists.
		const existingTriage = getDb().query(
			`SELECT id FROM jobs WHERE task_id = ? AND stage_kind = 'triage' AND status NOT IN ('done', 'failed', 'cancelled')`,
		).get(task.id) as { id: string } | null;
		if (existingTriage) return;

		updateTask(task.id, { last_external_review_id: String(latest.id) });
		spawnTriageJob(task.id);
		log.info('task-pr-poller', `task ${task.id} APPROVED by ${latest.author?.login ?? 'unknown'} → spawned triage`);
		return;
	}

	if (latest.state === 'CHANGES_REQUESTED') {
		updateTask(task.id, { last_external_review_id: String(latest.id) });
		try {
			await resumeDevForExternalFix(task.id, latest.body);
			log.info('task-pr-poller', `task ${task.id} CHANGES_REQUESTED by ${latest.author?.login ?? 'unknown'} → resumed dev for fix`);
		} catch (err) {
			log.warn('task-pr-poller', `failed to resume dev for task ${task.id}: ${err}`);
		}
		return;
	}

	// COMMENTED / PENDING / DISMISSED → ignore (per design Q14b)
}

/**
 * Filter reviews to the latest with a state we care about (APPROVED or
 * CHANGES_REQUESTED), ignoring COMMENTED/PENDING/DISMISSED. Sort by id
 * descending — review ids are monotonic per PR.
 */
function pickLatestActionableReview(reviews: GhReview[]): GhReview | null {
	const actionable = reviews.filter(r => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
	if (actionable.length === 0) return null;
	return actionable.reduce((latest, r) => (r.id > latest.id ? r : latest));
}

async function fetchPrSummary(prUrl: string): Promise<GhPrSummary | null> {
	try {
		const json = await execGh([
			'pr', 'view', prUrl,
			'--json', 'merged,mergedAt,state,reviews',
		]);
		const parsed = JSON.parse(json) as GhPrSummary;
		return parsed;
	} catch (err) {
		log.warn('task-pr-poller', `gh pr view failed for ${prUrl}: ${err}`);
		return null;
	}
}
