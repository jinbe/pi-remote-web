import { getCommands, isActive } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ commands: [] });
	}
	try {
		const commands = await getCommands(params.id);
		return json({ commands });
	} catch (e: any) {
		throw error(500, `Failed to get commands: ${e.message || e}`);
	}
};
