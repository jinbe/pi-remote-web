/**
 * POST /api/jobs/:id/run — Force-dispatch a queued job now, bypassing the
 * CI-ready gate and the normal poll cadence.
 */
import { json, error } from '@sveltejs/kit';
import { forceDispatchJob } from '$lib/server/job-poller';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const job = await forceDispatchJob(params.id);
		if (!job) throw error(404, 'Job not found');
		return json({ job });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(400, e.message || 'Failed to run job');
	}
};
