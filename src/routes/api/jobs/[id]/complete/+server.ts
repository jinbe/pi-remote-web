/**
 * POST /api/jobs/:id/complete — Callback hook for job completion.
 * Called by the Pi extension when a job finishes.
 */
import { json, error } from '@sveltejs/kit';
import { handleCompletion } from '$lib/server/job-completion';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { status, prUrl, verdict, error: jobError, resultSummary } = body;

		if (!status || !['done', 'failed'].includes(status)) {
			throw error(400, 'Invalid status — must be "done" or "failed"');
		}

		const job = handleCompletion(params.id, {
			jobId: params.id,
			status,
			prUrl,
			verdict,
			error: jobError,
			resultSummary,
		});

		return json({ job });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(400, e.message || 'Failed to complete job');
	}
};
