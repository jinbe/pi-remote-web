/**
 * POST /api/monitored-repos/:id/scan — Manually trigger a scan for a specific repo
 */
import { json, error } from '@sveltejs/kit';
import { scanRepos, getMonitoredRepo } from '$lib/server/github-pr-poller';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	const repo = getMonitoredRepo(params.id);
	if (!repo) throw error(404, 'Monitored repo not found');

	try {
		const result = await scanRepos(params.id);
		return json({ result });
	} catch (e: any) {
		throw error(500, `Scan failed: ${e.message || e}`);
	}
};
