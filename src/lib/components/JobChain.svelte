<script lang="ts">
	import { timeAgo } from '$lib/utils';
	import Icon from './Icon.svelte';

	interface Job {
		id: string;
		type?: 'task' | 'review' | null;
		status: string;
		title: string;
		review_verdict: string | null;
		loop_count: number;
		max_loops: number;
		created_at: string;
		pr_url: string | null;
	}

	let { jobs = [] }: { jobs: Job[] } = $props();

	const statusDot: Record<string, string> = {
		queued: 'bg-base-content/20',
		claimed: 'bg-info',
		running: 'bg-warning',
		reviewing: 'bg-secondary',
		done: 'bg-success',
		failed: 'bg-error',
		cancelled: 'bg-base-content/10',
	};
</script>

<div class="flex flex-col gap-0">
	{#each jobs as job, i (job.id)}
		<div class="flex items-start gap-3">
			<!-- Timeline connector -->
			<div class="flex flex-col items-center">
				<div class="w-3 h-3 rounded-full {statusDot[job.status] ?? 'bg-base-content/20'} flex-shrink-0 mt-1"></div>
				{#if i < jobs.length - 1}
					<div class="w-0.5 flex-1 min-h-[1.5rem] {statusDot[job.status] ?? 'bg-base-content/10'} opacity-30"></div>
				{/if}
			</div>

			<!-- Job info -->
			<div class="flex-1 pb-3 min-w-0">
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-xs font-mono opacity-50 inline-flex">
						{#if job.type === 'task'}<Icon name="hammer" class="w-3.5 h-3.5" />{:else}<Icon name="search" class="w-3.5 h-3.5" />{/if}
					</span>
					<span class="text-sm font-medium truncate">{job.title}</span>
					{#if job.review_verdict === 'approved'}
						<span class="badge badge-xs badge-success">✓ approved</span>
					{:else if job.review_verdict === 'changes_requested'}
						<span class="badge badge-xs badge-warning">changes requested</span>
					{/if}
				</div>
				<div class="text-xs text-base-content/40 mt-0.5">
					{job.status} · {timeAgo(job.created_at)}
					{#if job.pr_url}
						· <a href={job.pr_url} target="_blank" rel="noopener noreferrer" class="link link-primary">PR</a>
					{/if}
				</div>
			</div>
		</div>
	{/each}
</div>
