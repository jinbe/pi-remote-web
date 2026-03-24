/**
 * POST /api/jobs/:id/retry — Retry a failed job.
 */
import { json, error } from '@sveltejs/kit';
import { retryJob } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const job = retryJob(params.id);
		if (!job) throw error(404, 'Job not found');
		return json({ job });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(400, e.message || 'Failed to retry job');
	}
};
