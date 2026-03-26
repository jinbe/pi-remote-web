/**
 * POST /api/jobs/:id/complete — Callback hook for job completion.
 * Called by the Pi extension when a job finishes.
 * Requires a valid callback_token for authentication.
 */
import { json, error } from '@sveltejs/kit';
import { handleCompletion } from '$lib/server/job-completion';
import { getJob } from '$lib/server/job-queue';
import { log } from '$lib/server/logger';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { status, prUrl, verdict, error: jobError, resultSummary, token } = body;

		log.info('job-callback-api', `received callback for job ${params.id}: status=${status}, verdict=${verdict ?? 'none'}`);

		// Authenticate via per-job callback token
		const job = getJob(params.id);
		if (!job) throw error(404, 'Job not found');

		if (!token || token !== job.callback_token) {
			throw error(403, 'Invalid or missing callback token');
		}

		if (!status || !['done', 'failed', 'reviewing'].includes(status)) {
			throw error(400, 'Invalid status — must be "done", "failed", or "reviewing"');
		}

		const updated = await handleCompletion(params.id, {
			jobId: params.id,
			status,
			prUrl,
			verdict,
			error: jobError,
			resultSummary,
		});

		log.info('job-callback-api', `callback for job ${params.id} processed — job status: ${updated.status}`);

		return json({ job: updated });
	} catch (e: any) {
		// Re-throw SvelteKit HttpErrors (they have .status from error() helper)
		if (e.status && typeof e.body === 'object') throw e;

		log.error('job-callback-api', `callback for job ${params.id} failed: ${e.message ?? e}`);
		throw error(500, e.message || 'Failed to complete job');
	}
};
