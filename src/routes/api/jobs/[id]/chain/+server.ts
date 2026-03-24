/**
 * GET /api/jobs/:id/chain — Get the full chain of linked jobs.
 */
import { json, error } from '@sveltejs/kit';
import { getJobChain, getJob } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) throw error(404, 'Job not found');

	const chain = getJobChain(params.id);
	return json({ chain });
};
