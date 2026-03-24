<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticLight, hapticMedium } from '$lib/haptics';
	import { timeAgo } from '$lib/utils';
	import Icon from './Icon.svelte';
	import JobChain from './JobChain.svelte';

	interface Job {
		id: string;
		type: 'task' | 'review';
		status: string;
		title: string;
		repo: string | null;
		branch: string | null;
		pr_url: string | null;
		review_verdict: string | null;
		review_skill: string | null;
		loop_count: number;
		max_loops: number;
		parent_job_id: string | null;
		created_at: string;
		updated_at: string;
		error: string | null;
	}

	let { jobs = [], repo = '' }: { jobs: Job[]; repo?: string } = $props();

	let expandedJob = $state<string | null>(null);
	let chainJobs = $state<Job[]>([]);
	let loadingChain = $state(false);

	const statusBadge: Record<string, string> = {
		queued: 'badge-ghost',
		claimed: 'badge-info',
		running: 'badge-warning',
		done: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-ghost opacity-50',
	};

	const statusIconName: Record<string, string> = {
		queued: 'hourglass',
		claimed: 'lock',
		running: 'bolt',
		done: '',
		failed: '',
		cancelled: '',
	};

	const statusIconFallback: Record<string, string> = {
		done: '✓',
		failed: '✕',
		cancelled: '—',
	};

	// Filter jobs for the given repo (if provided)
	const filteredJobs = $derived(
		repo ? jobs.filter((j) => j.repo === repo) : jobs
	);

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

	async function deleteJob(jobId: string) {
		if (!confirm('Delete this job?')) return;
		hapticMedium();
		try {
			await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to delete job:', e);
		}
	}
</script>

{#if filteredJobs.length === 0}
	<div class="py-4 text-center text-sm text-base-content/50">
		No jobs yet
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
						<span class="badge badge-xs badge-outline" title="Loop {job.loop_count}/{job.max_loops}">
							↻ {job.loop_count}/{job.max_loops}
						</span>
					{/if}

					<!-- Review skill badge -->
					{#if job.review_skill}
						<span class="badge badge-xs badge-secondary hidden sm:inline-flex items-center gap-1" title="Review skill: {job.review_skill}">
							<Icon name="target" class="w-3 h-3" /> {job.review_skill}
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
						{#if statusIconName[job.status]}<Icon name={statusIconName[job.status]} class="w-3 h-3" />{:else}{statusIconFallback[job.status] ?? ''}{/if} {job.status}
					</span>

					<!-- Timestamp -->
					<span class="text-xs text-base-content/40 hidden sm:inline">
						{timeAgo(job.created_at)}
					</span>

					<!-- Actions -->
					{#if job.status === 'failed'}
						<button
							class="btn btn-ghost btn-xs"
							onclick={(e) => { e.stopPropagation(); retryJob(job.id); }}
							title="Retry"
						>↻</button>
					{/if}
					{#if ['queued', 'done', 'failed', 'cancelled'].includes(job.status)}
						<button
							class="btn btn-ghost btn-xs text-error/60"
							onclick={(e) => { e.stopPropagation(); deleteJob(job.id); }}
							title="Delete"
						>✕</button>
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
	</div>
{/if}
