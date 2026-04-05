/**
 * POST /api/monitored-repos/scan — Manually trigger a scan of all enabled repos
 *                                    (ignores manual_only flag for this call)
 */
import { json, error } from '@sveltejs/kit';
import { scanAllRepos } from '$lib/server/github-pr-poller';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const result = await scanAllRepos();
		return json({ result });
	} catch (e: any) {
		throw error(500, `Scan failed: ${e.message || e}`);
	}
};
