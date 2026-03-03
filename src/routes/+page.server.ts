import { listSessions } from '$lib/server/session-scanner';
import { getActiveSessionIds, getStreamingState } from '$lib/server/rpc-manager';
import { getFavoriteProjects, getAllDevCommands } from '$lib/server/cache';
import { getRunningDevServerCwds } from '$lib/server/dev-server-manager';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const sessions = await listSessions();
	const activeSessionIds = [...getActiveSessionIds()];
	const streamingSessionIds = activeSessionIds.filter(
		(id) => getStreamingState(id).isStreaming
	);
	const favoriteProjects = [...getFavoriteProjects()];
	const devCommands = Object.fromEntries(getAllDevCommands());
	const runningDevServers = getRunningDevServerCwds();

	return {
		sessions: sessions.map((s) => ({
			...s,
			lastModified: s.lastModified.toISOString()
		})),
		activeSessionIds,
		streamingSessionIds,
		favoriteProjects,
		devCommands,
		runningDevServers
	};
};
