/**
 * Orchestrates stage transitions for task-system jobs.
 *
 * Stage-kind jobs are: planning, dev, internal_review, triage.
 * Internal-review-fix and external-review-fix loops do NOT spawn new jobs —
 * they reuse the dev session by sending a follow-up prompt and flipping the
 * dev job back to running. This preserves the dev agent's context across
 * fix iterations.
 *
 * The orchestrator is called from:
 *   - Job poller's handleJobAgentEnd when a stage-kind job emits its marker.
 *   - The plan-accept API endpoint when the user accepts a planning chat.
 *   - The external-review listener when GitHub events fire.
 */
import { getDb } from './cache';
import { log } from './logger';
import { createJob, updateJobStatus, getJob } from './job-queue';
import {
	getTask,
	updateTask,
	transitionStage,
	type Task,
	type TaskStage,
} from './task-queue';
import { devGate, getWorktree, advanceWorktree, type Worktree } from './worktree-manager';
import {
	buildPlanningPrompt,
	buildDevPrompt,
	buildDevFixPrompt,
	buildInternalReviewPrompt,
	buildExternalReviewFixPrompt,
	buildTriagePrompt,
	type UpstreamContext,
} from './task-prompts';
import { sendMessage } from './rpc-manager';

export type StageKind = 'planning' | 'dev' | 'internal_review' | 'triage';

// --- Helpers ---

/**
 * Collect upstream-task context for the planner: every task in the same worktree
 * with a position less than this task that hasn't reached `done` yet.
 */
export function getUpstreamContext(task: Task): UpstreamContext[] {
	return getDb().query(
		`SELECT id, title, description, current_pr_url AS pr_url, stage
		 FROM tasks
		 WHERE worktree_id = ?
		   AND position < ?
		   AND stage NOT IN ('done', 'cancelled')
		 ORDER BY position ASC`,
	).all(task.worktree_id, task.position) as UpstreamContext[];
}

/**
 * Generate a feature-branch name from worktree slug + task position.
 * Result is git-safe and stable for a given (worktree, task).
 */
export function branchNameForTask(task: Task, worktree: Worktree): string {
	return `pi/${worktree.slug}/t${task.position}`;
}

// --- Stage spawn helpers ---

/**
 * Spawn the planning job for a task that's just been created. Creates a job row
 * with stage_kind='planning' and links it to the task. The poller will pick it
 * up and start an interactive session.
 */
export function spawnPlanningJob(taskId: string): { job_id: string } {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.stage !== 'planning') throw new Error(`Task ${taskId} is in stage ${task.stage}, expected planning`);

	const wt = getWorktree(task.worktree_id);
	if (!wt) throw new Error(`Worktree ${task.worktree_id} not found`);

	const job = createJob({
		title: `[planning] ${task.title}`,
		description: task.description ?? undefined,
		repo: wt.dir_path,
		harness: 'pi',
	});

	getDb().run(
		`UPDATE jobs SET task_id = ?, stage_kind = 'planning' WHERE id = ?`,
		[task.id, job.id],
	);
	updateTask(task.id, { current_job_id: job.id });

	log.info('task-orchestrator', `spawned planning job ${job.id} for task ${task.id}`);
	return { job_id: job.id };
}

/**
 * Accept a planning conversation: marks the planning job done, saves the final
 * description on the task, transitions the task to `queued`, and conditionally
 * spawns the dev job if the worktree's dev gate is open.
 *
 * Called from POST /api/tasks/[id]/accept-plan.
 */
export function acceptPlanning(taskId: string, finalDescription: string): Task {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.stage !== 'planning') throw new Error(`Task ${taskId} not in planning stage (is ${task.stage})`);

	if (task.current_job_id) {
		updateJobStatus(task.current_job_id, { status: 'done', result_summary: 'Planning accepted by user' });
	}

	updateTask(task.id, { description: finalDescription, current_job_id: null, current_session_id: null });
	transitionStage(task.id, 'queued');

	// If gate is open, spawn dev now. Otherwise, dev will be spawned by tryAdvanceQueuedTask
	// when the predecessor finishes.
	const gate = devGate(task.worktree_id);
	if (gate.ready) {
		spawnDevJob(task.id);
	} else {
		log.info('task-orchestrator', `task ${taskId} queued; dev blocked by ${(gate as { blockedBy: string }).blockedBy}`);
	}

	return getTask(task.id)!;
}

/**
 * Spawn the dev job for a queued task. Pre-condition: the worktree's dev gate
 * is already open. Caller is responsible for checking devGate.
 */
export function spawnDevJob(taskId: string): { job_id: string } {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.stage !== 'queued') throw new Error(`Task ${taskId} not in queued stage (is ${task.stage})`);

	const wt = getWorktree(task.worktree_id)!;
	const branch = branchNameForTask(task, wt);

	const job = createJob({
		title: `[dev] ${task.title}`,
		description: task.description ?? undefined,
		repo: wt.dir_path,
		harness: 'pi',
		max_loops: wt.internal_loop_cap,
	});

	getDb().run(
		`UPDATE jobs SET task_id = ?, stage_kind = 'dev' WHERE id = ?`,
		[task.id, job.id],
	);
	updateTask(task.id, { stage: 'dev', branch, current_job_id: job.id });

	log.info('task-orchestrator', `spawned dev job ${job.id} for task ${task.id} on branch ${branch}`);
	return { job_id: job.id };
}

/**
 * Spawn the internal-review job after dev pushed a branch. Always a fresh session.
 */
export function spawnInternalReviewJob(taskId: string): { job_id: string } {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.stage !== 'internal_review') throw new Error(`Task ${taskId} not in internal_review (is ${task.stage})`);

	const wt = getWorktree(task.worktree_id)!;
	const job = createJob({
		title: `[internal-review] ${task.title}`,
		repo: wt.dir_path,
		branch: task.branch ?? undefined,
		target_branch: wt.base_branch,
		harness: 'pi',
	});
	getDb().run(`UPDATE jobs SET task_id = ?, stage_kind = 'internal_review' WHERE id = ?`, [task.id, job.id]);
	updateTask(task.id, { current_job_id: job.id });

	log.info('task-orchestrator', `spawned internal-review job ${job.id} for task ${task.id}`);
	return { job_id: job.id };
}

/**
 * Spawn the triage job after a human reviewer APPROVES the PR.
 */
export function spawnTriageJob(taskId: string): { job_id: string } {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.stage !== 'external_review') throw new Error(`Task ${taskId} not in external_review (is ${task.stage})`);
	if (!task.current_pr_url) throw new Error(`Task ${taskId} has no PR URL — cannot triage`);

	const wt = getWorktree(task.worktree_id)!;
	const job = createJob({
		title: `[triage] ${task.title}`,
		repo: wt.dir_path,
		pr_url: task.current_pr_url,
		harness: 'pi',
	});
	getDb().run(`UPDATE jobs SET task_id = ?, stage_kind = 'triage' WHERE id = ?`, [task.id, job.id]);
	updateTask(task.id, { current_job_id: job.id });

	log.info('task-orchestrator', `spawned triage job ${job.id} for task ${task.id}`);
	return { job_id: job.id };
}

// --- Session-resume helpers (no new job rows) ---

/**
 * Internal-review verdict was changes_requested. Resume the dev session with a
 * fix prompt; bumps the dev job's status to running and increments the task's
 * internal_loop_count. No new job row.
 */
export async function resumeDevForInternalFix(taskId: string, reviewFeedback: string): Promise<void> {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (!task.current_session_id) throw new Error(`Task ${taskId} has no current_session_id — cannot resume dev`);

	const nextLoop = task.internal_loop_count + 1;
	const wt = getWorktree(task.worktree_id)!;
	if (nextLoop > wt.internal_loop_cap) {
		transitionStage(taskId, 'failed', { error: `Internal review loop cap reached (${wt.internal_loop_cap})` });
		return;
	}

	updateTask(task.id, { internal_loop_count: nextLoop, stage: 'dev' });
	if (task.current_job_id) {
		updateJobStatus(task.current_job_id, { status: 'running' });
	}

	const fixPrompt = buildDevFixPrompt(task, wt, reviewFeedback);
	await sendMessage(task.current_session_id, fixPrompt);
	log.info('task-orchestrator', `resumed dev session ${task.current_session_id} for task ${taskId} (internal fix loop ${nextLoop})`);
}

/**
 * Human reviewer requested changes. Resume the dev session with a fix prompt
 * that points the agent at the unresolved review threads. Increments
 * external_loop_count.
 */
export async function resumeDevForExternalFix(taskId: string, reviewerSummary: string): Promise<void> {
	const task = getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (!task.current_session_id) throw new Error(`Task ${taskId} has no current_session_id — cannot resume dev`);

	const wt = getWorktree(task.worktree_id)!;
	const nextLoop = task.external_loop_count + 1;
	if (nextLoop > wt.external_loop_cap) {
		transitionStage(taskId, 'failed', { error: `External review loop cap reached (${wt.external_loop_cap})` });
		return;
	}

	updateTask(task.id, { external_loop_count: nextLoop });
	if (task.current_job_id) {
		updateJobStatus(task.current_job_id, { status: 'running' });
	}

	const fixPrompt = buildExternalReviewFixPrompt(task, wt, reviewerSummary);
	await sendMessage(task.current_session_id, fixPrompt);
	log.info('task-orchestrator', `resumed dev session ${task.current_session_id} for task ${taskId} (external fix loop ${nextLoop})`);
}

// --- Stage completion handlers ---

/**
 * Handle a task whose PR has been merged. Marks task done, advances the worktree
 * (pulls main + checkout fresh), and spawns the next queued task's dev job.
 */
export async function handleTaskMerged(taskId: string): Promise<void> {
	const task = getTask(taskId);
	if (!task) return;
	if (task.stage === 'done') return; // idempotent

	transitionStage(taskId, 'done');

	try {
		await advanceWorktree(task.worktree_id);
	} catch (err) {
		log.warn('task-orchestrator', `advanceWorktree failed for ${task.worktree_id}: ${err}`);
	}

	tryAdvanceQueuedTask(task.worktree_id);
}

/**
 * Look for the next queued task in the worktree and spawn its dev job if the gate
 * is open. Idempotent — does nothing if no queued task or gate closed.
 */
export function tryAdvanceQueuedTask(worktreeId: string): void {
	const gate = devGate(worktreeId);
	if (!gate.ready) return;

	const next = getDb().query(
		`SELECT id FROM tasks WHERE worktree_id = ? AND stage = 'queued' ORDER BY position ASC LIMIT 1`,
	).get(worktreeId) as { id: string } | null;
	if (!next) return;

	spawnDevJob(next.id);
}

// --- Prompt builder dispatch (used by job-poller) ---

/**
 * Return the initial prompt for a newly-dispatched stage-kind job. Used by the
 * job poller's dispatchJob path.
 */
export function buildPromptForStage(stageKind: StageKind, task: Task, worktree: Worktree): string {
	switch (stageKind) {
		case 'planning':
			return buildPlanningPrompt(task, worktree, getUpstreamContext(task));
		case 'dev':
			return buildDevPrompt(task, worktree, task.branch ?? branchNameForTask(task, worktree));
		case 'internal_review':
			return buildInternalReviewPrompt(task, worktree);
		case 'triage':
			return buildTriagePrompt(task, worktree);
		default: {
			const _exhaustive: never = stageKind;
			throw new Error(`Unknown stage_kind: ${_exhaustive}`);
		}
	}
}

// --- Re-exports for the job-poller transition handler ---
export { getJob };
