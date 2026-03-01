import { getActiveSessionIds, stopSession } from '$lib/server/rpc-manager';
import { stopAllDevServers } from '$lib/server/dev-server-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const activeIds = [...getActiveSessionIds()];
		const [, devServersStopped] = await Promise.all([
			Promise.allSettled(activeIds.map((id) => stopSession(id))),
			stopAllDevServers()
		]);
		return json({ ok: true, stopped: activeIds.length, devServersStopped });
	} catch (e) {
		throw error(500, `Failed to stop all sessions: ${e}`);
	}
};
