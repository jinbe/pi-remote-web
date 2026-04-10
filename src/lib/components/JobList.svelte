<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticLight, hapticMedium } from '$lib/haptics';
	import { timeAgo } from '$lib/utils';
	import Icon, { type IconName } from "./Icon.svelte";
	import JobChain from './JobChain.svelte';

	interface Job {
		id: string;
		type?: 'task' | 'review' | null;
		status: string;
		title: string;
		repo: string | null;
		branch: string | null;
		pr_url: string | null;
		review_verdict: string | null;
		loop_count: number;
		max_loops: number;
		parent_job_id: string | null;
		session_id: string | null;
		created_at: string;
		updated_at: string;
		error: string | null;
		analysis_json?: string | null;
		review_prompt?: string | null;
	}

	/** Statuses considered active (in-progress). */
	const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running', 'reviewing']);

	let { jobs = [], repo = '', showAllByDefault = false }: { jobs: Job[]; repo?: string; showAllByDefault?: boolean } = $props();

	let showAll = $state(showAllByDefault);
	let expandedJob = $state<string | null>(null);
	let chainJobs = $state<Job[]>([]);
	let loadingChain = $state(false);

	const statusBadge: Record<string, string> = {
		queued: 'badge-ghost',
		claimed: 'badge-info',
		running: 'badge-warning',
		reviewing: 'badge-secondary',
		done: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-ghost opacity-50',
	};
	const statusIconName: Record<string, IconName> = {
		queued: 'clock',
		claimed: 'lock',
		running: 'bolt',
		reviewing: 'search',
	};

	const statusIconFallback: Record<string, IconName> = {
		done: 'check',
		failed: 'close',
		cancelled: 'dash',
	};

	// Filter jobs: by repo (if provided) and by active status (unless showAll)
	const repoJobs = $derived(
		repo ? jobs.filter((j) => j.repo === repo) : jobs
	);
	const activeJobs = $derived(repoJobs.filter((j) => ACTIVE_STATUSES.has(j.status)));
	const filteredJobs = $derived(showAll ? repoJobs : activeJobs);
	const hiddenCount = $derived(repoJobs.length - activeJobs.length);

	async function toggleChain(jobId: string) {
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
				const data = await res.json();
				chainJobs = data.chain;
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

	async function markJobDone(jobId: string) {
		hapticMedium();
		try {
			const res = await fetch(`/api/jobs/${jobId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'done' }),
			});
			if (!res.ok) { console.error('Failed to mark job as done:', res.status, await res.text()); return; }
			invalidateAll();
		} catch (e) {
			console.error('Failed to mark job as done:', e);
		}
	}

	async function cancelJob(jobId: string) {
		if (!confirm('Cancel this job? The session will be stopped.')) return;
		hapticMedium();
		try {
			const res = await fetch(`/api/jobs/${jobId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'cancelled' }),
			});
			if (!res.ok) { console.error('Failed to cancel job:', res.status, await res.text()); return; }
			invalidateAll();
		} catch (e) {
			console.error('Failed to cancel job:', e);
		}
	}

	async function forceJobDone(jobId: string) {
		if (!confirm('Force this job as done? The session will be stopped.')) return;
		hapticMedium();
		try {
			const res = await fetch(`/api/jobs/${jobId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'done' }),
			});
			if (!res.ok) { console.error('Failed to force job done:', res.status, await res.text()); return; }
			invalidateAll();
		} catch (e) {
			console.error('Failed to force job done:', e);
		}
	}

	async function deleteJob(jobId: string) {
		if (!confirm('Delete this job?')) return;
		hapticMedium();
		try {
			const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
			if (!res.ok) { console.error('Failed to delete job:', res.status, await res.text()); return; }
			invalidateAll();
		} catch (e) {
			console.error('Failed to delete job:', e);
		}
	}
</script>

{#if repoJobs.length === 0}
	<div class="py-4 text-center text-sm text-base-content/50">
		No jobs yet
	</div>
{:else if filteredJobs.length === 0}
	<div class="py-2 text-center text-sm text-base-content/50">
		No active jobs
		{#if hiddenCount > 0}
			<span class="mx-1">·</span>
			<button class="link link-primary text-sm" onclick={() => { hapticLight(); showAll = true; }}>
				Show {hiddenCount} completed
			</button>
		{/if}
	</div>
{:else}
	<div class="flex flex-col gap-2">
		{#each filteredJobs as job (job.id)}
			<div class="rounded-lg border border-base-300 bg-base-100/50 overflow-hidden">
				<!-- Job row -->
				<div
					class="flex items-center gap-2 px-3 py-2 hover:bg-base-200/50 transition-colors cursor-pointer"
					role="button"
					tabindex="0"
					onclick={() => toggleChain(job.id)}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleChain(job.id); }}
				>
					<!-- Type icon -->
					<span class="text-xs font-mono opacity-60 inline-flex">
						{#if job.type === 'task'}<Icon name="hammer" class="w-3.5 h-3.5" />{:else}<Icon name="search" class="w-3.5 h-3.5" />{/if}
					</span>

					<!-- Title -->
					<span class="flex-1 truncate text-sm font-medium">{job.title}</span>

					<!-- Loop indicator -->
					{#if job.loop_count > 0 || job.parent_job_id}
						<span class="badge badge-xs badge-outline inline-flex items-center gap-0.5" title="Loop {job.loop_count}/{job.max_loops}">
							<Icon name="refresh" class="w-2.5 h-2.5" /> {job.loop_count}/{job.max_loops}
						</span>
					{/if}

					<!-- Verdict badge for reviews -->
					{#if job.review_verdict === 'approved'}
						<span class="badge badge-xs badge-success">approved</span>
					{:else if job.review_verdict === 'changes_requested'}
						<span class="badge badge-xs badge-warning">changes</span>
					{/if}

					<!-- Status badge -->
					<span class="badge badge-xs {statusBadge[job.status] ?? 'badge-ghost'} inline-flex items-center gap-0.5">
						{#if statusIconName[job.status]}<Icon name={statusIconName[job.status]} class="w-3 h-3" />{:else if statusIconFallback[job.status]}<Icon name={statusIconFallback[job.status]} class="w-3 h-3" />{/if} {job.status}
					</span>

					<!-- Timestamp -->
					<span class="text-xs text-base-content/40 hidden sm:inline">
						{timeAgo(job.created_at)}
					</span>

					<!-- Actions -->
					{#if job.status === 'claimed'}
						<button
							class="btn btn-ghost btn-xs text-error/60"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
							title="Cancel"
						><Icon name="close" class="w-3.5 h-3.5" /></button>
					{:else if job.status === 'running' || job.status === 'reviewing'}
						<button
							class="btn btn-ghost btn-xs text-success"
							onclick={(e) => { e.stopPropagation(); job.status === 'running' ? forceJobDone(job.id) : markJobDone(job.id); }}
							title={job.status === 'running' ? 'Force done' : 'Mark as done'}
						><Icon name="check" class="w-3.5 h-3.5" /></button>
						<button
							class="btn btn-ghost btn-xs text-error/60"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
							title="Cancel"
						><Icon name="close" class="w-3.5 h-3.5" /></button>
					{/if}
					{#if job.status === 'failed'}
						<button
							class="btn btn-ghost btn-xs"
							onclick={(e) => { e.stopPropagation(); retryJob(job.id); }}
							title="Retry"
						><Icon name="refresh" class="w-3.5 h-3.5" /></button>
					{/if}
					{#if ['queued', 'done', 'failed', 'cancelled'].includes(job.status)}
						<button
							class="btn btn-ghost btn-xs text-error/60"
							onclick={(e) => { e.stopPropagation(); deleteJob(job.id); }}
							title="Delete"
						><Icon name="close" class="w-3.5 h-3.5" /></button>
					{/if}
				</div>

				<!-- Error message -->
				{#if job.error && expandedJob === job.id}
					<div class="px-3 pb-2 text-xs text-error">{job.error}</div>
				{/if}

				<!-- PR link -->
				{#if job.pr_url && expandedJob === job.id}
					<div class="px-3 pb-2 text-xs">
						<a href={job.pr_url} target="_blank" rel="noopener noreferrer" class="link link-primary">
							{job.pr_url}
						</a>
					</div>
				{/if}

				<!-- PR Analysis & Review Prompt -->
				{#if expandedJob === job.id}
					{#if job.analysis_json}
						<div class="px-3 pb-2">
							<details class="text-xs">
								<summary class="text-base-content/50 cursor-pointer select-none hover:text-base-content/70">PR Analysis</summary>
								<pre class="bg-base-200/50 rounded p-2 mt-1 overflow-x-auto font-mono whitespace-pre-wrap">{JSON.stringify(JSON.parse(job.analysis_json), null, 2)}</pre>
							</details>
						</div>
					{/if}
					{#if job.review_prompt}
						<div class="px-3 pb-2">
							<details class="text-xs">
								<summary class="text-base-content/50 cursor-pointer select-none hover:text-base-content/70">Review Prompt</summary>
								<div class="bg-base-200/50 rounded p-2 mt-1 whitespace-pre-wrap">{job.review_prompt}</div>
							</details>
						</div>
					{/if}
				{/if}

				<!-- Go to session link + action buttons for active jobs -->
				{#if expandedJob === job.id && ['running', 'reviewing'].includes(job.status)}
					<div class="px-3 pb-2 flex flex-wrap gap-2">
						{#if job.session_id}
							<a
								href="/session/{job.session_id}"
								class="btn btn-xs btn-outline btn-primary gap-1"
							>
								<Icon name="chevron-right" class="w-3 h-3" />
								View Session
							</a>
						{/if}
						<button
							class="btn btn-xs btn-outline btn-success gap-1"
							onclick={(e) => { e.stopPropagation(); job.status === 'running' ? forceJobDone(job.id) : markJobDone(job.id); }}
						>
							<Icon name="check" class="w-3 h-3" />
							{job.status === 'running' ? 'Force Done' : 'Done'}
						</button>
						<button
							class="btn btn-xs btn-outline btn-error gap-1"
							onclick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
						>
							<Icon name="close" class="w-3 h-3" />
							Cancel
						</button>
					</div>
				{/if}

				<!-- Chain visualisation -->
				{#if expandedJob === job.id}
					{#if loadingChain}
						<div class="px-3 pb-3">
							<span class="loading loading-dots loading-xs"></span>
						</div>
					{:else if chainJobs.length > 1}
						<div class="px-3 pb-3 border-t border-base-300 pt-2">
							<JobChain jobs={chainJobs} />
						</div>
					{/if}
				{/if}
			</div>
		{/each}

		<!-- Show all / Show active toggle -->
		{#if hiddenCount > 0}
			<div class="text-center pt-1">
				<button
					class="link text-xs text-base-content/40 hover:text-base-content/60"
					onclick={() => { hapticLight(); showAll = !showAll; }}
				>
					{#if showAll}
						Hide {hiddenCount} completed
					{:else}
						Show {hiddenCount} completed
					{/if}
				</button>
			</div>
		{/if}
	</div>
{/if}
