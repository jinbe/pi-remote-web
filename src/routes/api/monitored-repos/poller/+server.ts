/**
 * GET /api/monitored-repos/poller — Get PR poller status
 * POST /api/monitored-repos/poller — Start or stop the PR poller
 */
import { json, error } from '@sveltejs/kit';
import { start, stop, isRunning, getPollIntervalMs, getConcurrency } from '$lib/server/github-pr-poller';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({
		running: isRunning(),
		pollIntervalMs: getPollIntervalMs(),
		concurrency: getConcurrency(),
	});
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
		throw error(500, `Failed to control PR poller: ${e.message || e}`);
	}
};
