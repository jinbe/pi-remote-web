import { getCommands, isActive } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ commands: [] });
	}
	try {
		const result = await getCommands(params.id);
		// RPC may return { commands: [...] } or [...] directly
		const commands = Array.isArray(result) ? result : (result?.commands ?? []);
		return json({ commands });
	} catch (e: any) {
		throw error(500, `Failed to get commands: ${e.message || e}`);
	}
};
