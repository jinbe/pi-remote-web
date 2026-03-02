import { json } from '@sveltejs/kit';
import { getActiveSessionIds, getActiveSession } from '$lib/server/rpc-manager';
import { decodeSessionId, parseSessionMetadata } from '$lib/server/session-scanner';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const activeIds = [...getActiveSessionIds()];

	const sessions = await Promise.all(
		activeIds.map(async (id) => {
			const filePath = decodeSessionId(id);
			const info = getActiveSession(id);
			try {
				const meta = await parseSessionMetadata(filePath);
				return {
					id,
					name: meta.name,
					firstMessage: meta.firstMessage,
					cwd: meta.cwd,
					model: meta.model,
					shortName: meta.cwd.split('/').filter(Boolean).slice(-1).join('/')
				};
			} catch {
				return {
					id,
					name: null,
					firstMessage: '(new session)',
					cwd: info?.cwd ?? '',
					model: info?.model ?? null,
					shortName: (info?.cwd ?? '').split('/').filter(Boolean).slice(-1).join('/')
				};
			}
		})
	);

	return json(sessions);
};
