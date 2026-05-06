/**
 * GET    /api/tasks/[id]              — get task with linked job rows
 * DELETE /api/tasks/[id]              — cancel task (advances queue, does NOT halt)
 */
import { json, error } from '@sveltejs/kit';
import { getTask, cancelTask } from '$lib/server/task-queue';
import { getDb } from '$lib/server/cache';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const task = getTask(params.id);
	if (!task) throw error(404, 'Task not found');
	const jobs = getDb().query(
		`SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at ASC`,
	).all(task.id);
	return json({ task, jobs });
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	try {
		const reason = url.searchParams.get('reason') ?? 'Cancelled by user';
		const task = cancelTask(params.id, reason);
		return json({ task });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(409, e.message ?? String(e));
	}
};
