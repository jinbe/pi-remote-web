/**
 * GET /api/jobs/poller — Get poller status
 * POST /api/jobs/poller — Start or stop the poller
 */
import { json, error } from '@sveltejs/kit';
import { start, stop, isRunning } from '$lib/server/job-poller';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ running: isRunning() });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { action } = body;

		if (action === 'start') {
			start();
			return json({ running: true });
		} else if (action === 'stop') {
			stop();
			return json({ running: false });
		} else {
			throw error(400, 'Invalid action — must be "start" or "stop"');
		}
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to control poller: ${e.message || e}`);
	}
};
