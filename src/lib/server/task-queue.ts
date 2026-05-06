/**
 * Task queue: CRUD + stage transitions for tasks within worktrees.
 *
 * A task progresses through these stages:
 *   planning → queued → dev → internal_review → external_review → awaiting_merge → done
 * Terminal alternatives at any point: failed, cancelled.
 *
 * Each stage's *work* is performed by a job row (see jobs.stage_kind). This module
 * keeps task state in sync with the active job and enforces the worktree's serial
 * dev gate + single planning slot.
 */
import { getDb } from './cache';
import { log } from './logger';
import { getWorktree, haltWorktree } from './worktree-manager';

// --- Types ---

export type TaskStage =
	| 'planning'
	| 'queued'
	| 'dev'
	| 'internal_review'
	| 'external_review'
	| 'awaiting_merge'
	| 'done'
	| 'failed'
	| 'cancelled';

export interface Task {
	id: string;
	worktree_id: string;
	title: string;
	description: string | null;
	source_url: string | null;
	position: number;
	stage: TaskStage;
	current_pr_url: string | null;
	current_pr_number: number | null;
	branch: string | null;
	current_session_id: string | null;
	current_job_id: string | null;
	internal_loop_count: number;
	external_loop_count: number;
	triage_plan_json: string | null;
	error: string | null;
	last_external_review_id: string | null;
	created_at: string;
	completed_at: string | null;
}

export interface CreateTaskInput {
	worktree_id: string;
	title: string;
	description?: string;
	source_url?: string;
}

export interface UpdateTaskInput {
	stage?: TaskStage;
	description?: string;
	current_pr_url?: string | null;
	current_pr_number?: number | null;
	branch?: string | null;
	current_session_id?: string | null;
	current_job_id?: string | null;
	internal_loop_count?: number;
	external_loop_count?: number;
	triage_plan_json?: string | null;
	error?: string | null;
	last_external_review_id?: string | null;
}

const ACTIVE_STAGES: TaskStage[] = [
	'planning',
	'queued',
	'dev',
	'internal_review',
	'external_review',
	'awaiting_merge',
];

const TERMINAL_STAGES: TaskStage[] = ['done', 'failed', 'cancelled'];

// --- Public API: CRUD ---

/**
 * Create a task in a worktree. Enforces single-planning-slot per worktree.
 * Position is appended at the tail of the worktree's queue.
 *
 * Throws if the worktree is closed/halted, or if another task in the same
 * worktree is already in `planning` stage.
 */
export function createTask(input: CreateTaskInput): Task {
	const wt = getWorktree(input.worktree_id);
	if (!wt) throw new Error(`Worktree ${input.worktree_id} not found`);
	if (wt.status === 'closed') throw new Error(`Worktree ${input.worktree_id} is closed`);
	if (wt.status === 'halted') throw new Error(`Worktree ${input.worktree_id} is halted (${wt.halt_reason}); resume before creating new tasks`);

	const planningInFlight = getDb().query(
		`SELECT id FROM tasks WHERE worktree_id = ? AND stage = 'planning' LIMIT 1`,
	).get(input.worktree_id) as { id: string } | null;
	if (planningInFlight) {
		throw new Error(`Worktree ${input.worktree_id} already has a task in planning (${planningInFlight.id}); only one planning slot per worktree`);
	}

	const maxPosRow = getDb().query(
		`SELECT COALESCE(MAX(position), 0) AS max_pos FROM tasks WHERE worktree_id = ?`,
	).get(input.worktree_id) as { max_pos: number };
	const position = maxPosRow.max_pos + 1;

	const row = getDb().query(`
		INSERT INTO tasks (worktree_id, title, description, source_url, position)
		VALUES ($worktree_id, $title, $description, $source_url, $position)
		RETURNING *
	`).get({
		$worktree_id: input.worktree_id,
		$title: input.title,
		$description: input.description ?? null,
		$source_url: input.source_url ?? null,
		$position: position,
	}) as Task;

	getDb().run(
		`UPDATE worktrees SET last_activity_at = datetime('now') WHERE id = ?`,
		[input.worktree_id],
	);
	log.info('task-queue', `created task ${row.id} (${row.title}) in worktree ${input.worktree_id} at position ${position}`);
	return row;
}

export function getTask(id: string): Task | null {
	return getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function listTasks(filter?: { worktree_id?: string; stage?: TaskStage }): Task[] {
	const conditions: string[] = [];
	const params: Record<string, any> = {};
	if (filter?.worktree_id) { conditions.push('worktree_id = $worktree_id'); params.$worktree_id = filter.worktree_id; }
	if (filter?.stage) { conditions.push('stage = $stage'); params.$stage = filter.stage; }
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	return getDb().query(
		`SELECT * FROM tasks ${where} ORDER BY worktree_id, position`,
	).all(params) as Task[];
}

export function updateTask(id: string, updates: UpdateTaskInput): Task | null {
	const setClauses: string[] = [];
	const params: Record<string, any> = { $id: id };

	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		setClauses.push(`${key} = $${key}`);
		params[`$${key}`] = value;
	}
	if (setClauses.length === 0) return getTask(id);

	if (updates.stage && (updates.stage === 'done' || updates.stage === 'failed' || updates.stage === 'cancelled')) {
		setClauses.push(`completed_at = datetime('now')`);
	}

	const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $id RETURNING *`;
	const row = getDb().query(sql).get(params) as Task | null;
	if (row) {
		getDb().run(`UPDATE worktrees SET last_activity_at = datetime('now') WHERE id = ?`, [row.worktree_id]);
		log.info('task-queue', `updated task ${id}: ${Object.keys(updates).join(', ')}`);
	}
	return row;
}

// --- Stage transitions ---

/**
 * Transition a task to a new stage with validation. Returns the updated row
 * or throws on an illegal transition.
 *
 * Legal forward transitions (matching the lifecycle):
 *   planning → queued | failed | cancelled
 *   queued → dev | failed | cancelled
 *   dev → internal_review | failed | cancelled
 *   internal_review → dev (changes_requested loop) | external_review (approved) | failed | cancelled
 *   external_review → dev (changes_requested) | awaiting_merge (approved+triaged) | failed | cancelled
 *   awaiting_merge → done | failed | cancelled
 *   done/failed/cancelled → (terminal, no transitions)
 *
 * On `failed` (not cancelled), the worktree is halted with the task's error as the reason.
 */
export function transitionStage(id: string, to: TaskStage, opts: { error?: string; pr_url?: string; pr_number?: number; branch?: string } = {}): Task {
	const task = getTask(id);
	if (!task) throw new Error(`Task ${id} not found`);
	if (TERMINAL_STAGES.includes(task.stage)) {
		throw new Error(`Task ${id} is already terminal (${task.stage})`);
	}
	if (!isLegalTransition(task.stage, to)) {
		throw new Error(`Illegal transition: ${task.stage} → ${to} (task ${id})`);
	}

	const updates: UpdateTaskInput = { stage: to };
	if (opts.error !== undefined) updates.error = opts.error;
	if (opts.pr_url !== undefined) {
		updates.current_pr_url = opts.pr_url;
		updates.current_pr_number = opts.pr_number ?? null;
	}
	if (opts.branch !== undefined) updates.branch = opts.branch;

	const row = updateTask(id, updates);
	if (!row) throw new Error(`Task ${id} disappeared mid-transition`);

	// Failure cascade: halt the worktree so subsequent tasks don't proceed.
	// Cancellation does NOT halt — that's a deliberate user action that should
	// let the queue advance to the next task.
	if (to === 'failed') {
		const reason = opts.error ?? `task ${id} failed`;
		haltWorktree(row.worktree_id, reason);
		// Pause any in-flight planning of later tasks in the same worktree —
		// their context just got invalidated by an upstream failure.
		pauseInFlightPlanning(row.worktree_id, id);
	}

	log.info('task-queue', `task ${id} stage transition: ${task.stage} → ${to}`);
	return row;
}

function isLegalTransition(from: TaskStage, to: TaskStage): boolean {
	if (TERMINAL_STAGES.includes(from)) return false;
	if (to === 'failed' || to === 'cancelled') return ACTIVE_STAGES.includes(from);

	switch (from) {
		case 'planning': return to === 'queued';
		case 'queued': return to === 'dev';
		case 'dev': return to === 'internal_review';
		case 'internal_review': return to === 'dev' || to === 'external_review';
		case 'external_review': return to === 'dev' || to === 'awaiting_merge';
		case 'awaiting_merge': return to === 'done';
		default: return false;
	}
}

/**
 * Cancel a planning task in the worktree (other than the failing one) so a future
 * retry can re-plan with up-to-date context. The active planning session — if any —
 * is left alive but the task is marked cancelled; the session_watcher will clean up.
 */
function pauseInFlightPlanning(worktreeId: string, excludeTaskId: string): void {
	const planning = getDb().query(
		`SELECT id FROM tasks WHERE worktree_id = ? AND stage = 'planning' AND id != ?`,
	).all(worktreeId, excludeTaskId) as { id: string }[];

	for (const row of planning) {
		updateTask(row.id, { stage: 'cancelled', error: 'Cancelled because an upstream task in the worktree failed' });
		log.warn('task-queue', `cancelled in-flight planning task ${row.id} due to upstream failure in worktree ${worktreeId}`);
	}
}

// --- Cancellation (user-initiated, advances queue) ---

/**
 * User-initiated cancellation. Distinct from `failed`: does NOT halt the worktree,
 * the queue advances to the next task as if this one was never there.
 */
export function cancelTask(id: string, reason = 'Cancelled by user'): Task {
	return transitionStage(id, 'cancelled', { error: reason });
}
