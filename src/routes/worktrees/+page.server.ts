import { listWorktrees } from '$lib/server/worktree-manager';
import { listTasks } from '$lib/server/task-queue';
import { getDb } from '$lib/server/cache';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const worktrees = listWorktrees();
	const tasks = listTasks();
	// Pull repo paths from monitored_repos with local_path set, for the new-worktree picker.
	const repos = getDb().query(
		`SELECT DISTINCT local_path FROM monitored_repos WHERE local_path IS NOT NULL AND enabled = 1`,
	).all() as { local_path: string }[];
	return {
		worktrees,
		tasks,
		repoPaths: repos.map(r => r.local_path),
	};
};
