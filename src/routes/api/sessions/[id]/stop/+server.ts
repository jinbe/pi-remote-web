import { stopSession } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		await stopSession(params.id);
		return json({ ok: true });
	} catch (e) {
		throw error(500, `Failed to stop session: ${e}`);
	}
};
