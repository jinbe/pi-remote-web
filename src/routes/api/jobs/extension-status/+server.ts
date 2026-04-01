/**
 * GET /api/jobs/extension-status — Check if the job-callback extension is installed and up to date.
 * POST /api/jobs/extension-status — Install or update the extension (symlink).
 */
import { json, error } from '@sveltejs/kit';
import { getExtensionStatus, installExtension } from '$lib/server/extension-status';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const status = await getExtensionStatus();
		return json(status);
	} catch (e: any) {
		throw error(500, e.message || 'Failed to check extension status');
	}
};

export const POST: RequestHandler = async () => {
	try {
		const status = await installExtension();
		return json(status);
	} catch (e: any) {
		throw error(500, e.message || 'Failed to install extension');
	}
};
