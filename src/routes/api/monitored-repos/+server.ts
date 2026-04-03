/**
 * GET /api/monitored-repos — List all monitored repos
 * POST /api/monitored-repos — Add a new monitored repo
 */
import { json, error } from '@sveltejs/kit';
import { getMonitoredRepos, createMonitoredRepo } from '$lib/server/github-pr-poller';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const repos = getMonitoredRepos();
	return json({ repos });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { owner, name, local_path, assigned_only, manual_only, enabled } = body;

		if (!owner?.trim() || !name?.trim()) {
			throw error(400, 'Owner and name are required');
		}

		const repo = createMonitoredRepo({
			owner: owner.trim(),
			name: name.trim(),
			local_path: local_path?.trim() || undefined,
			assigned_only: assigned_only !== undefined ? Boolean(assigned_only) : undefined,
			manual_only: manual_only !== undefined ? Boolean(manual_only) : undefined,
			enabled: enabled !== undefined ? Boolean(enabled) : undefined,
		});

		return json({ repo }, { status: 201 });
	} catch (e: any) {
		if (e.status) throw e;
		// Handle unique constraint violation
		if (e.message?.includes('UNIQUE constraint')) {
			throw error(409, 'This repository is already being monitored');
		}
		throw error(500, `Failed to add repo: ${e.message || e}`);
	}
};
