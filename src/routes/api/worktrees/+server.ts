/**
 * GET  /api/worktrees       — list worktrees, optional ?status=, ?repo=
 * POST /api/worktrees       — create a new worktree (eager git worktree add)
 */
import { json, error } from '@sveltejs/kit';
import {
	listWorktrees,
	createWorktree,
	type Worktree,
} from '$lib/server/worktree-manager';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') as Worktree['status'] | null;
	const repo = url.searchParams.get('repo');
	const worktrees = listWorktrees({
		status: status ?? undefined,
		repo: repo ?? undefined,
	});
	return json({ worktrees });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { repo, first_task_title, base_branch, slug } = body;

		if (!repo || typeof repo !== 'string') {
			throw error(400, 'repo (absolute path) is required');
		}

		const wt = await createWorktree({
			repo: repo.trim(),
			first_task_title: first_task_title?.trim() || undefined,
			base_branch: base_branch?.trim() || undefined,
			slug: slug?.trim() || undefined,
		});
		return json({ worktree: wt }, { status: 201 });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to create worktree: ${e.message ?? e}`);
	}
};
