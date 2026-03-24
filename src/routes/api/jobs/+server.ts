/**
 * GET /api/jobs — List jobs with optional filters
 * POST /api/jobs — Create a new job
 */
import { json, error } from '@sveltejs/kit';
import { getJobs, createJob } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') ?? undefined;
	const type = url.searchParams.get('type') ?? undefined;
	const repo = url.searchParams.get('repo') ?? undefined;

	const jobs = getJobs({ status, type, repo });
	return json({ jobs });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { type, title, description, repo, branch, issue_url, target_branch, priority, max_loops } = body;

		if (!type || !['task', 'review'].includes(type)) {
			throw error(400, 'Invalid job type — must be "task" or "review"');
		}
		if (!title || typeof title !== 'string' || !title.trim()) {
			throw error(400, 'Title is required');
		}

		const job = createJob({
			type,
			title: title.trim(),
			description: description?.trim() || undefined,
			repo: repo?.trim() || undefined,
			branch: branch?.trim() || undefined,
			issue_url: issue_url?.trim() || undefined,
			target_branch: target_branch?.trim() || undefined,
			priority: typeof priority === 'number' ? priority : undefined,
			max_loops: typeof max_loops === 'number' ? max_loops : undefined,
		});

		return json({ job }, { status: 201 });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to create job: ${e.message || e}`);
	}
};
