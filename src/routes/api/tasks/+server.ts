/**
 * GET  /api/tasks   — list tasks, optional ?worktree_id=, ?stage=
 * POST /api/tasks   — create a task (auto-spawns planning job)
 *
 * Creation flow: caller supplies worktree_id (or new_worktree_repo to auto-create
 * a worktree). The new task is created in `planning` stage and a planning job is
 * spawned immediately so the user can open the chat session.
 */
import { json, error } from '@sveltejs/kit';
import { createTask, listTasks, type TaskStage } from '$lib/server/task-queue';
import { createWorktree } from '$lib/server/worktree-manager';
import { spawnPlanningJob } from '$lib/server/task-orchestrator';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const worktree_id = url.searchParams.get('worktree_id') ?? undefined;
	const stage = (url.searchParams.get('stage') as TaskStage | null) ?? undefined;
	const tasks = listTasks({ worktree_id, stage });
	return json({ tasks });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { worktree_id, new_worktree_repo, title, description, source_url } = body;

		if (!title || typeof title !== 'string') {
			throw error(400, 'title is required');
		}

		let resolvedWorktreeId = worktree_id?.trim() || null;

		// Auto-create a worktree if requested. Convenience for the "new task,
		// no deps" creation flow that auto-spawns a fresh worktree.
		if (!resolvedWorktreeId && new_worktree_repo) {
			const wt = await createWorktree({
				repo: String(new_worktree_repo).trim(),
				first_task_title: title,
			});
			resolvedWorktreeId = wt.id;
		}

		if (!resolvedWorktreeId) {
			throw error(400, 'worktree_id or new_worktree_repo is required');
		}

		const task = createTask({
			worktree_id: resolvedWorktreeId,
			title: title.trim(),
			description: description?.trim() || undefined,
			source_url: source_url?.trim() || undefined,
		});

		const { job_id } = spawnPlanningJob(task.id);

		return json({ task, planning_job_id: job_id }, { status: 201 });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, e.message ?? String(e));
	}
};
