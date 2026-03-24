/**
 * GET /api/jobs/:id — Get job details
 * PATCH /api/jobs/:id — Update a job
 * DELETE /api/jobs/:id — Delete a job
 */
import { json, error } from '@sveltejs/kit';
import { getJob, updateJobStatus, deleteJob } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) throw error(404, 'Job not found');
	return json({ job });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { status, pr_url, pr_number, review_verdict, session_id, worktree_path, result_summary, error: jobError, branch } = body;

		const job = updateJobStatus(params.id, {
			status,
			pr_url,
			pr_number,
			review_verdict,
			session_id,
			worktree_path,
			result_summary,
			error: jobError,
			branch,
		});

		if (!job) throw error(404, 'Job not found');
		return json({ job });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to update job: ${e.message || e}`);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const job = deleteJob(params.id);
		if (!job) throw error(404, 'Job not found');
		return json({ job });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(400, e.message || 'Failed to delete job');
	}
};
