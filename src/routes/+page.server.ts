import { listSessions } from '$lib/server/session-scanner';
import { getActiveSessionIds, getStreamingState } from '$lib/server/rpc-manager';
import { getFavoriteProjects, getAllDevCommands } from '$lib/server/cache';
import { getRunningDevServerCwds } from '$lib/server/dev-server-manager';
import { getJobs } from '$lib/server/job-queue';
import { isRunning as isPollerRunning } from '$lib/server/job-poller';
import type { PageServerLoad } from './$types';

/** Pattern matching worktree directories created by the job poller. */
const WORKTREE_CWD_PATTERN = /\/\.worktrees\/job-/;

export const load: PageServerLoad = async () => {
	const allSessions = await listSessions();
	// Hide sessions running inside job worktrees — they clutter the dashboard
	const sessions = allSessions.filter((s) => !WORKTREE_CWD_PATTERN.test(s.cwd));
	const activeSessionIds = [...getActiveSessionIds()];
	const streamingSessionIds = activeSessionIds.filter(
		(id) => getStreamingState(id).isStreaming
	);
	const favoriteProjects = [...getFavoriteProjects()];
	const devCommands = Object.fromEntries(getAllDevCommands());
	const runningDevServers = getRunningDevServerCwds();
	const jobs = getJobs();
	const pollerRunning = isPollerRunning();

	return {
		sessions: sessions.map((s) => ({
			...s,
			lastModified: s.lastModified.toISOString()
		})),
		activeSessionIds,
		streamingSessionIds,
		favoriteProjects,
		devCommands,
		runningDevServers,
		jobs,
		pollerRunning,
	};
};
