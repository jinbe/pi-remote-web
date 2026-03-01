import { listSessions } from '$lib/server/session-scanner';
import { getActiveSessionIds } from '$lib/server/rpc-manager';
import { getFavoriteProjects } from '$lib/server/cache';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const sessions = await listSessions();
	const activeSessionIds = [...getActiveSessionIds()];
	const favoriteProjects = [...getFavoriteProjects()];

	return {
		sessions: sessions.map((s) => ({
			...s,
			lastModified: s.lastModified.toISOString()
		})),
		activeSessionIds,
		favoriteProjects
	};
};
