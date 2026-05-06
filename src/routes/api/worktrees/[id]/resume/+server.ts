/**
 * POST /api/worktrees/[id]/resume — clear halted state on a worktree.
 * After resuming, the user is responsible for retrying or cancelling the
 * failed task that caused the halt; the queue won't auto-advance until then.
 */
import { json, error } from '@sveltejs/kit';
import { resumeWorktree } from '$lib/server/worktree-manager';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	const wt = resumeWorktree(params.id);
	if (!wt) throw error(409, 'Worktree not found or not in halted state');
	return json({ worktree: wt });
};
