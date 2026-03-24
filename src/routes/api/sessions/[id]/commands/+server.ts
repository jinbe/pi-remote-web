import { getCommands, isActive } from '$lib/server/rpc-manager';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ commands: [] });
	}
	try {
		const result = await getCommands(params.id);
		const commands = Array.isArray(result) ? result : (result?.commands ?? []);
		return json({ commands });
	} catch {
		// Timeout or error — return empty, prefetch will populate cache eventually
		return json({ commands: [] });
	}
};
