/**
 * GET  /api/settings — read all app-level settings
 * PUT  /api/settings — update app-level settings (partial)
 */
import { json, error } from '@sveltejs/kit';
import { getSetting, setSetting } from '$lib/server/app-settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({
		personal_review_prompt: getSetting('personal_review_prompt'),
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		if (typeof body.personal_review_prompt === 'string') {
			setSetting('personal_review_prompt', body.personal_review_prompt);
		}
		return json({
			personal_review_prompt: getSetting('personal_review_prompt'),
		});
	} catch (e: any) {
		throw error(500, `Failed to update settings: ${e.message || e}`);
	}
};
