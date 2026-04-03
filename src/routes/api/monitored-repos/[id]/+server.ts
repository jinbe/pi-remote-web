/**
 * GET /api/monitored-repos/:id — Get a single monitored repo
 * PATCH /api/monitored-repos/:id — Update a monitored repo
 * DELETE /api/monitored-repos/:id — Remove a monitored repo
 */
import { json, error } from '@sveltejs/kit';
import { getMonitoredRepo, updateMonitoredRepo, deleteMonitoredRepo } from '$lib/server/github-pr-poller';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const repo = getMonitoredRepo(params.id);
	if (!repo) throw error(404, 'Monitored repo not found');
	return json({ repo });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { local_path, assigned_only, manual_only, enabled } = body;

		const repo = updateMonitoredRepo(params.id, {
			local_path: local_path !== undefined ? (local_path?.trim() || null) : undefined,
			assigned_only: assigned_only !== undefined ? Boolean(assigned_only) : undefined,
			manual_only: manual_only !== undefined ? Boolean(manual_only) : undefined,
			enabled: enabled !== undefined ? Boolean(enabled) : undefined,
		});

		if (!repo) throw error(404, 'Monitored repo not found');
		return json({ repo });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to update repo: ${e.message || e}`);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	const repo = deleteMonitoredRepo(params.id);
	if (!repo) throw error(404, 'Monitored repo not found');
	return json({ repo });
};
