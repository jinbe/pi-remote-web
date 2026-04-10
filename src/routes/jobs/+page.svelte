<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { timeAgo, shortenHome } from '$lib/utils';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import AddJobModal from '$lib/components/AddJobModal.svelte';
	import AddReviewJobModal from '$lib/components/AddReviewJobModal.svelte';
	import AddRepoModal from '$lib/components/AddRepoModal.svelte';
	import MonitoredRepos from '$lib/components/MonitoredRepos.svelte';
	import JobChain from '$lib/components/JobChain.svelte';
	import SwipeToDelete from '$lib/components/SwipeToDelete.svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { getContext } from 'svelte';
	import logoSvg from '$lib/assets/logo.svg';

	interface Job {
		id: string;
		type: 'task' | 'review';
		status: string;
		priority: number;
		title: string;
		description: string | null;
		repo: string | null;
		branch: string | null;
		pr_url: string | null;
		pr_number: number | null;
		review_verdict: string | null;
		loop_count: number;
		max_loops: number;
		parent_job_id: string | null;
		session_id: string | null;
		result_summary: string | null;
		created_at: string;
		updated_at: string;
		claimed_at: string | null;
		completed_at: string | null;
		error: string | null;
		retry_count: number;
		max_retries: number;
		no_verdict_retries: number;
		max_no_verdict_retries: number;
		model: string | null;
		harness: 'pi' | 'claude-code' | null;
		analysis_json: string | null;
		review_prompt: string | null;
	}

	let { data } = $props();

	const { theme, toggleTheme } = getContext<{ theme: 'dark' | 'light'; toggleTheme: () => void }>('theme');



	// Filter state
	let statusFilter = $state<string>('active');
	let typeFilter = $state<string>('all');
	let search = $state('');
	let showAddJob = $state(false);
	let showAddReviewJob = $state(false);
	let showAddRepo = $state(false);
	let prMonitorOpen = $state(false);

	// Expanded job for detail view
	let expandedJob = $state<string | null>(null);
	let chainJobs = $state<Job[]>([]);
	let loadingChain = $state(false);

	const STATUS_FILTERS = [
		{ value: 'active', label: 'Active' },
		{ value: 'queued', label: 'Queued' },
		{ value: 'running', label: 'Running' },
		{ value: 'reviewing', label: 'Reviewing' },
		{ value: 'done', label: 'Done' },
		{ value: 'failed', label: 'Failed' },
		{ value: 'all', label: 'All' },
	] as const;

	const TYPE_FILTERS = [
		{ value: 'all', label: 'All' },
		{ value: 'task', label: 'Tasks' },
		{ value: 'review', label: 'Reviews' },
	] as const;

	const statusBadge: Record<string, string> = {
		queued: 'badge-ghost',
		claimed: 'badge-info',
		running: 'badge-warning',
		reviewing: 'badge-info',
		done: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-ghost opacity-50',
	};

	const statusIconName: Record<string, IconName> = {
		queued: 'clock',
		claimed: 'lock',
		running: 'bolt',
		reviewing: 'search',
		done: 'check',
		failed: 'close',
		cancelled: 'dash',
	};

	// Active statuses: queued, claimed, running, reviewing
	const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running', 'reviewing']);

	const filteredJobs = $derived.by(() => {
		let jobs = data.jobs as Job[];

		// Status filter
		if (statusFilter === 'active') {
			jobs = jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
		} else if (statusFilter !== 'all') {
			jobs = jobs.filter((j) => j.status === statusFilter);
		}

		// Type filter
		if (typeFilter !== 'all') {
			jobs = jobs.filter((j) => j.type === typeFilter);
		}

		// Search filter
		const q = search.toLowerCase().trim();
		if (q) {
			jobs = jobs.filter(
				(j) =>
					j.title.toLowerCase().includes(q) ||
					(j.description?.toLowerCase().includes(q) ?? false) ||
					(j.repo?.toLowerCase().includes(q) ?? false) ||
					(j.branch?.toLowerCase().includes(q) ?? false) ||
					j.id.toLowerCase().includes(q)
			);
		}

		return jobs;
	});

	// Counts for filter badges
	const activeCount = $derived((data.jobs as Job[]).filter((j) => ACTIVE_STATUSES.has(j.status)).length);
	const queuedCount = $derived((data.jobs as Job[]).filter((j) => j.status === 'queued').length);
	const runningCount = $derived((data.jobs as Job[]).filter((j) => j.status === 'running').length);
	const reviewingCount = $derived((data.jobs as Job[]).filter((j) => j.status === 'reviewing').length);
	const doneCount = $derived((data.jobs as Job[]).filter((j) => j.status === 'done').length);
	const failedCount = $derived((data.jobs as Job[]).filter((j) => j.status === 'failed').length);
	const totalCount = $derived((data.jobs as Job[]).length);

	function countForFilter(value: string): number {
		switch (value) {
			case 'active': return activeCount;
			case 'queued': return queuedCount;
			case 'running': return runningCount;
			case 'reviewing': return reviewingCount;
			case 'done': return doneCount;
			case 'failed': return failedCount;
			case 'all': return totalCount;
			default: return 0;
		}
	}

	async function toggleExpand(jobId: string) {
		hapticLight();
		if (expandedJob === jobId) {
			expandedJob = null;
			chainJobs = [];
			return;
		}

		expandedJob = jobId;
		loadingChain = true;
		try {
			const res = await fetch(`/api/jobs/${jobId}/chain`);
			if (res.ok) {
				const result = await res.json();
				chainJobs = result.chain;
			}
		} catch {
			chainJobs = [];
		} finally {
			loadingChain = false;
		}
	}

	async function retryJob(jobId: string) {
		hapticMedium();
		try {
			await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to retry job:', e);
		}
	}

	async function cancelJob(jobId: string) {
		if (!confirm('Cancel this job? The session will be stopped.')) return;
		hapticMedium();
		try {
			await fetch(`/api/jobs/${jobId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'cancelled' }),
			});
			invalidateAll();
		} catch (e) {
			console.error('Failed to cancel job:', e);
		}
	}

	async function markJobDone(jobId: string) {
		hapticMedium();
		try {
			await fetch(`/api/jobs/${jobId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'done' }),
			});
			invalidateAll();
		} catch (e) {
			console.error('Failed to mark job as done:', e);
		}
	}

	async function deleteJob(jobId: string) {
		if (!confirm('Delete this job? This cannot be undone.')) return;
		hapticHeavy();
		try {
			await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to delete job:', e);
		}
	}

	/** Delete a job without confirmation — used by swipe-to-delete. */
	async function deleteJobDirect(jobId: string) {
		hapticHeavy();
		try {
			await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to delete job:', e);
		}
	}

	/** Clear all completed (done) jobs. */
	async function clearCompletedJobs() {
		const doneJobs = (data.jobs as Job[]).filter((j) => j.status === 'done');
		if (doneJobs.length === 0) return;
		if (!confirm(`Delete ${doneJobs.length} completed job${doneJobs.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
		hapticHeavy();
		try {
			await Promise.all(doneJobs.map((j) => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
			invalidateAll();
		} catch (e) {
			console.error('Failed to clear completed jobs:', e);
		}
	}

	/** Clear all failed jobs. */
	async function clearFailedJobs() {
		const failedJobs = (data.jobs as Job[]).filter((j) => j.status === 'failed');
		if (failedJobs.length === 0) return;
		if (!confirm(`Delete ${failedJobs.length} failed job${failedJobs.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
		hapticHeavy();
		try {
			await Promise.all(failedJobs.map((j) => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
			invalidateAll();
		} catch (e) {
			console.error('Failed to clear failed jobs:', e);
		}
	}

	async function togglePoller() {
		hapticMedium();
		const action = data.pollerRunning ? 'stop' : 'start';
		try {
			await fetch('/api/jobs/poller', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action }),
			});
			invalidateAll();
		} catch (e) {
			console.error('Failed to toggle poller:', e);
		}
	}

	// Auto-refresh via SSE (sessions + job events are both emitted on this endpoint)
	$effect(() => {
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const DEBOUNCE_MS = 500;

		function debouncedRefresh() {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				invalidateAll();
			}, DEBOUNCE_MS);
		}

		const es = new EventSource('/api/sessions/watch');
		es.onmessage = () => debouncedRefresh();

		return () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			es.close();
		};
	});
</script>

<svelte:head>
	<title>Jobs — Pi Dashboard</title>
</svelte:head>

{#snippet jobCard(job: Job)}
	<div class="rounded-lg border border-base-300 bg-base-200/50 overflow-hidden">
		<!-- Job header row -->
		<div
			class="flex items-center gap-2 px-4 py-3 hover:bg-base-300/50 transition-colors cursor-pointer"
			role="button"
			tabindex="0"
			onclick={() => toggleExpand(job.id)}
			onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(job.id); }}
		>
			<!-- Expand arrow -->
			<span class="inline-flex text-sm opacity-50 transition-transform {expandedJob === job.id ? 'rotate-90' : ''}"><Icon name="chevron-right" class="w-3.5 h-3.5" /></span>

			<!-- Type icon -->
			<span class="text-xs opacity-60 inline-flex">
				{#if job.type === 'task'}<Icon name="hammer" class="w-3.5 h-3.5" />{:else}<Icon name="search" class="w-3.5 h-3.5" />{/if}
			</span>

			<!-- Title -->
			<span class="flex-1 truncate text-sm font-medium">{job.title}</span>

			<!-- PR link (inline when done) -->
			{#if job.pr_url && (job.status === 'done' || job.status === 'reviewing')}
				<a
					href={job.pr_url}
					target="_blank"
					rel="noopener noreferrer"
					class="btn btn-xs btn-success btn-outline gap-1"
					onclick={(e) => e.stopPropagation()}
					title={job.pr_url}
				>
					PR <Icon name="chevron-right" class="w-3 h-3" />
				</a>
			{/if}

			<!-- Loop indicator -->
			{#if job.loop_count > 0 || job.parent_job_id}
				<span class="badge badge-xs badge-outline inline-flex items-center gap-0.5" title="Loop {job.loop_count}/{job.max_loops}">
					<Icon name="refresh" class="w-2.5 h-2.5" /> {job.loop_count}/{job.max_loops}
				</span>
			{/if}

			<!-- Harness badge -->
			{#if job.harness === 'claude-code'}
				<span class="badge badge-xs badge-outline" title="Claude Code">◆</span>
			{/if}

			<!-- Verdict badge -->
			{#if job.review_verdict === 'approved'}
				<span class="badge badge-xs badge-success">approved</span>
			{:else if job.review_verdict === 'changes_requested'}
				<span class="badge badge-xs badge-warning">changes</span>
			{/if}

			<!-- Priority -->
			{#if job.priority > 0}
				<span class="badge badge-xs badge-accent" title="Priority: {job.priority}">
					P{job.priority}
				</span>
			{/if}

			<!-- Status badge -->
			<span class="badge badge-xs {statusBadge[job.status] ?? 'badge-ghost'} inline-flex items-center gap-0.5">
				{#if statusIconName[job.status]}<Icon name={statusIconName[job.status]} class="w-3 h-3" />{/if} {job.status}
			</span>

			<!-- Timestamp -->
			<span class="text-xs text-base-content/40 hidden sm:inline">
				{timeAgo(job.created_at)}
			</span>
		</div>

		<!-- Expanded detail panel -->
		{#if expandedJob === job.id}
			<div class="border-t border-base-300 px-4 py-3 space-y-3">
				<!-- Metadata grid -->
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
					<div class="flex gap-2">
						<span class="text-base-content/50 w-20 flex-shrink-0">ID</span>
						<span class="font-mono truncate">{job.id}</span>
					</div>
					<div class="flex gap-2">
						<span class="text-base-content/50 w-20 flex-shrink-0">Type</span>
						<span class="inline-flex items-center gap-1">{#if job.type === 'task'}<Icon name="hammer" class="w-3.5 h-3.5" /> Task{:else}<Icon name="search" class="w-3.5 h-3.5" /> Review{/if}</span>
					</div>
					{#if job.repo}
						<div class="flex gap-2 sm:col-span-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Repo</span>
							<span class="truncate">{shortenHome(job.repo)}</span>
						</div>
					{/if}
					<div class="flex gap-2">
						<span class="text-base-content/50 w-20 flex-shrink-0">Harness</span>
						<span class="inline-flex items-center gap-1">{#if job.harness === 'claude-code'}◆ Claude Code{:else}π pi{/if}</span>
					</div>
					{#if job.model}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Model</span>
							<span class="font-mono truncate">{job.model}</span>
						</div>
					{/if}
					{#if job.branch}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Branch</span>
							<span class="font-mono truncate">{job.branch}</span>
						</div>
					{/if}
					<div class="flex gap-2">
						<span class="text-base-content/50 w-20 flex-shrink-0">Created</span>
						<span>{new Date(job.created_at).toLocaleString()}</span>
					</div>
					{#if job.claimed_at}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Claimed</span>
							<span>{new Date(job.claimed_at).toLocaleString()}</span>
						</div>
					{/if}
					{#if job.completed_at}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Completed</span>
							<span>{new Date(job.completed_at).toLocaleString()}</span>
						</div>
					{/if}
					{#if job.retry_count > 0}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Retries</span>
							<span>{job.retry_count}/{job.max_retries}</span>
						</div>
					{/if}
					{#if job.no_verdict_retries > 0}
						<div class="flex gap-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Nudges</span>
							<span>{job.no_verdict_retries}/{job.max_no_verdict_retries}</span>
						</div>
					{/if}
					{#if job.session_id}
						<div class="flex gap-2 sm:col-span-2">
							<span class="text-base-content/50 w-20 flex-shrink-0">Session</span>
							<a href="/session/{job.session_id}" class="link link-primary truncate">{job.session_id}</a>
						</div>
					{/if}
				</div>

				<!-- Description -->
				{#if job.description}
					<div class="text-sm bg-base-100/50 rounded-lg p-3 whitespace-pre-wrap">{job.description}</div>
				{/if}

				<!-- Result summary -->
				{#if job.result_summary}
					<div class="text-sm">
						<div class="text-xs font-semibold text-base-content/50 mb-1">Result</div>
						<div class="bg-base-100/50 rounded-lg p-3 whitespace-pre-wrap">{job.result_summary}</div>
					</div>
				{/if}

				<!-- Error -->
				{#if job.error}
					<div class="text-sm">
						<div class="text-xs font-semibold text-error/70 mb-1">Error</div>
						<div class="bg-error/10 rounded-lg p-3 text-error whitespace-pre-wrap">{job.error}</div>
					</div>
				{/if}

				<!-- PR Analysis -->
				{#if job.analysis_json}
					<details class="text-sm">
						<summary class="text-xs font-semibold text-base-content/50 cursor-pointer select-none hover:text-base-content/70">PR Analysis</summary>
						<pre class="bg-base-100/50 rounded-lg p-3 mt-1 overflow-x-auto text-xs font-mono whitespace-pre-wrap">{JSON.stringify(JSON.parse(job.analysis_json), null, 2)}</pre>
					</details>
				{/if}

				<!-- Review Prompt -->
				{#if job.review_prompt}
					<details class="text-sm">
						<summary class="text-xs font-semibold text-base-content/50 cursor-pointer select-none hover:text-base-content/70">Review Prompt</summary>
						<div class="bg-base-100/50 rounded-lg p-3 mt-1 whitespace-pre-wrap text-xs">{job.review_prompt}</div>
					</details>
				{/if}

				<!-- PR link -->
				{#if job.pr_url}
					<div class="text-sm">
						<a href={job.pr_url} target="_blank" rel="noopener noreferrer" class="link link-primary">
							{job.pr_url}
						</a>
					</div>
				{/if}

				<!-- Job chain visualisation -->
				{#if loadingChain}
					<div class="flex items-center gap-2 text-sm text-base-content/50">
						<span class="loading loading-dots loading-xs"></span>
						Loading chain...
					</div>
				{:else if chainJobs.length > 1}
					<div>
						<div class="text-xs font-semibold text-base-content/50 mb-2">Job Chain</div>
						<JobChain jobs={chainJobs} />
					</div>
				{/if}

				<!-- Action buttons -->
				<div class="flex gap-2 pt-1">
					{#if job.status === 'queued' || job.status === 'claimed'}
						<button
							class="btn btn-xs btn-error btn-outline"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
						>Cancel</button>
					{/if}
					{#if job.status === 'running'}
						<button
							class="btn btn-xs btn-success btn-outline gap-1"
							onclick={(e) => { e.stopPropagation(); if (confirm('Force this job as done? The session will be stopped.')) markJobDone(job.id); }}
						><Icon name="check" class="w-3 h-3" /> Force Done</button>
						<button
							class="btn btn-xs btn-error btn-outline gap-1"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
						><Icon name="close" class="w-3 h-3" /> Cancel</button>
					{/if}
					{#if job.status === 'reviewing'}
						<button
							class="btn btn-xs btn-success btn-outline gap-1"
							onclick={(e) => { e.stopPropagation(); markJobDone(job.id); }}
						><Icon name="check" class="w-3 h-3" /> Done</button>
						<button
							class="btn btn-xs btn-error btn-outline gap-1"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
						><Icon name="close" class="w-3 h-3" /> Cancel</button>
					{/if}
					{#if job.status === 'failed'}
						<button
							class="btn btn-xs btn-warning btn-outline gap-1"
							onclick={(e) => { e.stopPropagation(); retryJob(job.id); }}
						><Icon name="refresh" class="w-3 h-3" /> Retry</button>
					{/if}
					{#if ['queued', 'done', 'failed', 'cancelled'].includes(job.status)}
						<button
							class="btn btn-xs btn-error btn-outline"
							onclick={(e) => { e.stopPropagation(); deleteJob(job.id); }}
						>Delete</button>
					{/if}
					{#if job.session_id}
						<a href="/session/{job.session_id}" class="btn btn-xs btn-ghost gap-1">
							View Session <Icon name="chevron-right" class="w-3 h-3" />
						</a>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-4xl px-4 py-6 h-full overflow-y-auto">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<a href="/" class="btn btn-ghost btn-sm" aria-label="Back to dashboard">
				<img src={logoSvg} alt="Pi" class="h-6 w-6 rounded" />
			</a>
			<h1 class="text-lg font-bold">Jobs</h1>
		</div>
		<div class="flex gap-2 items-center">
			<!-- Poller status (compact) -->
			<button
				class="btn btn-sm {data.pollerRunning ? 'btn-success' : 'btn-ghost'}"
				onclick={togglePoller}
				title={data.pollerRunning ? 'Poller running — click to stop' : 'Poller stopped — click to start'}
			>
				{#if data.pollerRunning}
					<span class="relative flex h-2 w-2">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-content opacity-75"></span>
						<span class="relative inline-flex rounded-full h-2 w-2 bg-success-content"></span>
					</span>
					<span class="hidden sm:inline">Poller On</span>
				{:else}
					<span class="inline-block h-2 w-2 rounded-full bg-base-content/20"></span>
					<span class="hidden sm:inline">Poller Off</span>
				{/if}
			</button>
			<!-- Primary actions -->
			<button class="btn btn-sm btn-primary gap-1" onclick={() => { hapticMedium(); showAddJob = true; }}><Icon name="plus" class="w-4 h-4" /> <span class="hidden sm:inline">New Task</span><span class="sm:hidden">Task</span></button>
			<button class="btn btn-sm btn-secondary gap-1" onclick={() => { hapticMedium(); showAddReviewJob = true; }}><Icon name="search" class="w-4 h-4" /> <span class="hidden sm:inline">New Review</span><span class="sm:hidden">Review</span></button>
			<!-- Kebab menu -->
			<div class="dropdown dropdown-end">
				<div tabindex="0" role="button" class="btn btn-sm btn-ghost btn-circle" aria-label="More actions">
					<Icon name="more-vertical" class="w-5 h-5" />
				</div>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul tabindex="0" class="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow-lg border border-base-300">
					<li>
						<button onclick={() => { hapticLight(); invalidateAll(); }}>
							<Icon name="refresh" class="w-4 h-4" /> Refresh
						</button>
					</li>
					<li>
						<button onclick={() => { hapticLight(); toggleTheme(); }}>
							{#if theme === 'dark'}<Icon name="sun" class="w-4 h-4" /> Light Mode{:else}<Icon name="moon" class="w-4 h-4" /> Dark Mode{/if}
						</button>
					</li>
					{#if doneCount > 0}
						<div class="divider my-0"></div>
						<li>
							<button onclick={clearCompletedJobs} class="text-error">
								<Icon name="close" class="w-4 h-4" /> Clear done ({doneCount})
							</button>
						</li>
					{/if}
					{#if failedCount > 0}
						<li>
							<button onclick={clearFailedJobs} class="text-error">
								<Icon name="close" class="w-4 h-4" /> Clear failed ({failedCount})
							</button>
						</li>
					{/if}
				</ul>
			</div>
		</div>
	</div>

	<!-- Filters -->
	<div class="mb-4 flex flex-col gap-3">
		<!-- Status filter tabs -->
		<div class="flex flex-wrap gap-1">
			{#each STATUS_FILTERS as filter}
				<button
					class="btn btn-xs {statusFilter === filter.value ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => { hapticLight(); statusFilter = filter.value; }}
				>
					{filter.label}
					{#if countForFilter(filter.value) > 0}
						<span class="badge badge-xs {statusFilter === filter.value ? 'badge-primary-content bg-primary-content/20' : 'badge-ghost'}">{countForFilter(filter.value)}</span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- Type filter + search + clear completed -->
		<div class="flex gap-2 items-center">
			<div class="flex gap-1">
				{#each TYPE_FILTERS as filter}
					<button
						class="btn btn-xs {typeFilter === filter.value ? 'btn-secondary' : 'btn-ghost'} gap-0.5"
						onclick={() => { hapticLight(); typeFilter = filter.value; }}
					>
						{#if filter.value === 'task'}<Icon name="hammer" class="w-3 h-3" />{:else if filter.value === 'review'}<Icon name="search" class="w-3 h-3" />{/if}
						{filter.label}
					</button>
				{/each}
			</div>
			<input
				type="text"
				placeholder="Search jobs..."
				class="input input-xs flex-1"
				bind:value={search}
			/>
		</div>
	</div>

	<!-- PR Monitor (collapsible) -->
	<div class="mb-4">
		<MonitoredRepos
			repos={data.monitoredRepos}
			prPollerRunning={data.prPollerRunning}
			pollIntervalMs={data.prPollIntervalMs}
			concurrency={data.prPollConcurrency}
			onaddrepo={() => { showAddRepo = true; }}
			open={prMonitorOpen}
			ontoggle={(v) => { prMonitorOpen = v; }}
		/>
	</div>

	<!-- Jobs list -->
	{#if filteredJobs.length === 0}
		<div class="py-12 text-center text-base-content/50">
			{#if totalCount === 0}
				<p class="text-lg">No jobs yet</p>
				<p class="text-sm mt-1">Create a task or review job to get started.</p>
			{:else}
				<p class="text-sm">No jobs match the current filters.</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each filteredJobs as job (job.id)}
				{@const isDeletable = ['queued', 'done', 'failed', 'cancelled'].includes(job.status)}
				{#if isDeletable}
					<SwipeToDelete ondelete={() => deleteJobDirect(job.id)}>
						{@render jobCard(job)}
					</SwipeToDelete>
				{:else}
					{@render jobCard(job)}
				{/if}
			{/each}
		</div>
	{/if}
</div>

<AddJobModal
	open={showAddJob}
	defaultHarness={data.defaultHarness}
	onclose={() => (showAddJob = false)}
/>

<AddReviewJobModal
	open={showAddReviewJob}
	defaultHarness={data.defaultHarness}
	onclose={() => (showAddReviewJob = false)}
/>

<AddRepoModal
	open={showAddRepo}
	onclose={() => (showAddRepo = false)}
/>
