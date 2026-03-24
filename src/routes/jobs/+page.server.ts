import { getJobs } from '$lib/server/job-queue';
import { isRunning as isPollerRunning } from '$lib/server/job-poller';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const jobs = getJobs();
	const pollerRunning = isPollerRunning();

	return {
		jobs,
		pollerRunning,
	};
};
