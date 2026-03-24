/**
 * POST /api/jobs/:id/review — Enqueue a review for a completed job.
 * Creates a new review job linked to the given done job.
 */
import { json, error } from '@sveltejs/kit';
import { enqueueReview } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const reviewJob = enqueueReview(params.id);
		return json({ job: reviewJob });
	} catch (e: any) {
		if (e.message?.includes('not found')) {
			throw error(404, e.message);
		}
		throw error(400, e.message || 'Failed to enqueue review');
	}
};
