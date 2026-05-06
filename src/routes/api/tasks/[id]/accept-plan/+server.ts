/**
 * POST /api/tasks/[id]/accept-plan
 * Body: { description: string }
 *
 * Marks the task's planning job done, saves the user-edited description on the
 * task, transitions to queued, and spawns dev if the worktree's gate is open.
 */
import { json, error } from '@sveltejs/kit';
import { acceptPlanning } from '$lib/server/task-orchestrator';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { description } = body;
		if (!description || typeof description !== 'string') {
			throw error(400, 'description is required (the final task description)');
		}
		const task = acceptPlanning(params.id, description.trim());
		return json({ task });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(409, e.message ?? String(e));
	}
};
