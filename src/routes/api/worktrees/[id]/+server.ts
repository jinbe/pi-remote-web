/**
 * GET    /api/worktrees/[id]              — get worktree + its tasks
 * DELETE /api/worktrees/[id]              — close worktree (refuses if active tasks)
 * POST   /api/worktrees/[id]/resume       — resume a halted worktree (handled in nested route)
 */
import { json, error } from '@sveltejs/kit';
import { getWorktree, closeWorktree } from '$lib/server/worktree-manager';
import { listTasks } from '$lib/server/task-queue';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const wt = getWorktree(params.id);
	if (!wt) throw error(404, 'Worktree not found');
	const tasks = listTasks({ worktree_id: wt.id });
	return json({ worktree: wt, tasks });
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const force = url.searchParams.get('force') === 'true';
		const wt = await closeWorktree(params.id, force);
		if (!wt) throw error(404, 'Worktree not found');
		return json({ worktree: wt });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(409, e.message ?? String(e));
	}
};
