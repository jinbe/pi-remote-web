import { getActiveSessionIds, stopSession } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const activeIds = [...getActiveSessionIds()];
		await Promise.allSettled(activeIds.map((id) => stopSession(id)));
		return json({ ok: true, stopped: activeIds.length });
	} catch (e) {
		throw error(500, `Failed to stop all sessions: ${e}`);
	}
};
