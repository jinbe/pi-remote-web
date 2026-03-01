import { getSessionStats, isActive } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ active: false });
	}
	try {
		const stats = await getSessionStats(params.id);
		return json({ active: true, ...stats });
	} catch (e) {
		throw error(500, `Failed to get stats: ${e}`);
	}
};
