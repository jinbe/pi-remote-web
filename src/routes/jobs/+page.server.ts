import { getJobs } from '$lib/server/job-queue';
import { isRunning as isPollerRunning } from '$lib/server/job-poller';
import { isRunning as isPrPollerRunning, getMonitoredRepos, getPollIntervalMs, getConcurrency } from '$lib/server/github-pr-poller';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const jobs = await getJobs();
	const pollerRunning = isPollerRunning();
	const prPollerRunning = isPrPollerRunning();
	const monitoredRepos = getMonitoredRepos();
	const prPollIntervalMs = getPollIntervalMs();
	const prPollConcurrency = getConcurrency();

	return {
		jobs,
		pollerRunning,
		prPollerRunning,
		monitoredRepos,
		prPollIntervalMs,
		prPollConcurrency,
	};
};
