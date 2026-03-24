/**
 * POST /api/jobs/:id/complete — Callback hook for job completion.
 * Called by the Pi extension when a job finishes.
 * Requires a valid callback_token for authentication.
 */
import { json, error } from '@sveltejs/kit';
import { handleCompletion } from '$lib/server/job-completion';
import { getJob } from '$lib/server/job-queue';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { status, prUrl, verdict, error: jobError, resultSummary, token } = body;

		// Authenticate via per-job callback token
		const job = getJob(params.id);
		if (!job) throw error(404, 'Job not found');

		if (!token || token !== job.callback_token) {
			throw error(403, 'Invalid or missing callback token');
		}

		if (!status || !['done', 'failed'].includes(status)) {
			throw error(400, 'Invalid status — must be "done" or "failed"');
		}

		const updated = handleCompletion(params.id, {
			jobId: params.id,
			status,
			prUrl,
			verdict,
			error: jobError,
			resultSummary,
		});

		return json({ job: updated });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(400, e.message || 'Failed to complete job');
	}
};
