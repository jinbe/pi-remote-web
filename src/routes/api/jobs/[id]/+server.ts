/**
 * GET /api/jobs/:id — Get job details
 * PATCH /api/jobs/:id — Update a job (with validated status transitions)
 * DELETE /api/jobs/:id — Delete a job
 */
import { json, error } from '@sveltejs/kit';
import { getJob, updateJobStatus, deleteJob } from '$lib/server/job-queue';
import { stopSession } from '$lib/server/rpc-manager';
import { log } from '$lib/server/logger';
import type { RequestHandler } from './$types';

/** Allowed status transitions — maps current status to valid next statuses. */
const VALID_TRANSITIONS: Record<string, string[]> = {
	queued: ['claimed', 'cancelled'],
	claimed: ['running', 'failed', 'cancelled'],
	running: ['reviewing', 'done', 'failed', 'cancelled'],
	reviewing: ['running', 'done', 'failed', 'cancelled'],
	// Terminal states — no further transitions via PATCH (use retryJob for failed→queued)
	done: [],
	failed: [],
	cancelled: [],
};

/** Fields that can be updated via PATCH. Rejects internal-only fields like session_id. */
const ALLOWED_PATCH_FIELDS = ['status', 'pr_url', 'pr_number', 'review_verdict', 'result_summary', 'branch', 'review_skill'] as const;

export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) throw error(404, 'Job not found');
	return json({ job });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();

		const currentJob = getJob(params.id);
		if (!currentJob) throw error(404, 'Job not found');

		// Validate status transition if status is being changed
		if (body.status !== undefined) {
			const allowed = VALID_TRANSITIONS[currentJob.status];
			if (!allowed || !allowed.includes(body.status)) {
				throw error(400, `Invalid status transition: '${currentJob.status}' → '${body.status}'`);
			}
		}

		// Only allow safe fields through — reject internal fields
		const updates: Record<string, any> = {};
		for (const field of ALLOWED_PATCH_FIELDS) {
			if (body[field] !== undefined) {
				updates[field] = body[field];
			}
		}

		const job = updateJobStatus(params.id, updates);
		if (!job) throw error(404, 'Job not found');

		// Stop the session when transitioning to a terminal state via PATCH
		if (updates.status === 'done' || updates.status === 'failed' || updates.status === 'cancelled') {
			if (currentJob.session_id) {
				try {
					await stopSession(currentJob.session_id);
				} catch (err) {
					log.warn('jobs-api', `failed to stop session after PATCH to ${updates.status} for job ${params.id}: ${err}`);
				}
			}
		}

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
