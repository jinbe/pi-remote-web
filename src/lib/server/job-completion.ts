/**
 * Job completion handler.
 * The main completion logic (state machine) is in job-poller.ts (handleJobAgentEnd).
 *
 * The extension callback delegates to handleJobAgentEnd so the review loop
 * is respected — it never directly marks a job as done.
 */
import { getJob, updateJobStatus, type Job } from './job-queue';
import { log } from './logger';

// --- Types ---

export interface CompletionPayload {
	jobId: string;
	status: 'done' | 'failed' | 'reviewing';
	prUrl?: string;
	verdict?: 'approved' | 'changes_requested';
	error?: string;
	resultSummary?: string;
}

// --- Main handler ---

/**
 * Handle job completion callback from the extension.
 * Delegates to the poller's state machine so the review loop is respected.
 *
 * For failures, marks the job as failed directly (no state machine needed).
 * For success, constructs the assistant text markers and lets handleJobAgentEnd
 * drive the state transitions (running → reviewing → done).
 *
 * The server-side session subscription also calls handleJobAgentEnd on agent_end,
 * so the callback and subscription race. We guard against double-processing:
 * - Terminal states (done/failed/cancelled) are ignored outright.
 * - If the subscription already transitioned the job to the same state the
 *   callback wants (e.g. both want 'reviewing'), we skip the state machine
 *   but still update any missing fields (pr_url, verdict) from the callback.
 */
export async function handleCompletion(jobId: string, payload: CompletionPayload): Promise<Job> {
	// Dynamic import to avoid circular dependency — job-poller imports from us.
	// Cannot use require() because the project is ESM ("type": "module").
	const { handleJobAgentEnd } = await import('./job-poller');

	const job = getJob(jobId);
	if (!job) {
		throw new Error(`Job not found: ${jobId}`);
	}

	// If already in a terminal state, ignore
	if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
		log.info('job-completion', `job ${jobId} already in terminal state ${job.status} — ignoring callback`);
		return job;
	}

	// Handle failure directly — no state machine needed, but still clean up
	if (payload.status === 'failed') {
		const updated = updateJobStatus(jobId, {
			status: 'failed',
			error: payload.error ?? 'Job failed without error details',
			result_summary: payload.resultSummary,
		});
		log.info('job-completion', `job ${jobId} failed via callback: ${payload.error}`);

		return updated!;
	}

	// Guard against the subscription/callback race: if the subscription already
	// moved the job to 'reviewing' and the callback also reports 'reviewing',
	// don't re-run the state machine (which would see the job in 'reviewing'
	// without a VERDICT and either ignore it or mark it as failed). Instead,
	// just patch any missing fields from the callback payload.
	if (job.status === 'reviewing' && payload.status === 'reviewing') {
		const patchUpdates: Record<string, any> = {};
		if (payload.prUrl && !job.pr_url) patchUpdates.pr_url = payload.prUrl;
		if (payload.resultSummary && !job.result_summary) patchUpdates.result_summary = payload.resultSummary;

		if (Object.keys(patchUpdates).length > 0) {
			updateJobStatus(jobId, patchUpdates);
			log.info('job-completion', `job ${jobId} already reviewing — patched fields from callback: ${Object.keys(patchUpdates).join(', ')}`);
		} else {
			log.info('job-completion', `job ${jobId} already reviewing — callback is a no-op`);
		}
		return getJob(jobId) ?? job;
	}

	// Reconstruct the assistant text markers from the callback payload
	// so handleJobAgentEnd can extract them and drive the state machine.
	const markerLines: string[] = [];
	if (payload.prUrl) markerLines.push(`PR_URL: ${payload.prUrl}`);
	if (payload.verdict) markerLines.push(`VERDICT: ${payload.verdict}`);
	if (payload.resultSummary) markerLines.push(payload.resultSummary);
	const syntheticText = markerLines.join('\n');

	// Delegate to the state machine — this handles running → reviewing → done.
	// Await so the state transition completes before we return the updated job.
	await handleJobAgentEnd(jobId, syntheticText);

	// Return the updated job (state may have changed)
	return getJob(jobId) ?? job;
}


