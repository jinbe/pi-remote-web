import { getJobs } from '$lib/server/job-queue';
import { isRunning as isPollerRunning } from '$lib/server/job-poller';
import { getExtensionStatus } from '$lib/server/extension-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [jobs, extensionStatus] = await Promise.all([
		getJobs(),
		getExtensionStatus(),
	]);
	const pollerRunning = isPollerRunning();

	return {
		jobs,
		pollerRunning,
		extensionStatus,
	};
};
