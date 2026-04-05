<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import Icon from '$lib/components/Icon.svelte';
	import SwipeToDelete from '$lib/components/SwipeToDelete.svelte';

	interface MonitoredRepo {
		id: string;
		owner: string;
		name: string;
		local_path: string | null;
		assigned_only: number;
		manual_only: number;
		enabled: number;
		created_at: string;
		updated_at: string;
	}

	let {
		repos,
		prPollerRunning,
		pollIntervalMs,
		concurrency,
		onaddrepo,
		open = false,
		ontoggle,
	}: {
		repos: MonitoredRepo[];
		prPollerRunning: boolean;
		pollIntervalMs: number;
		concurrency: number;
		onaddrepo?: () => void;
		open?: boolean;
		ontoggle?: (open: boolean) => void;
	} = $props();

	let scanningRepo = $state<string | null>(null);
	let scanningAll = $state(false);

	function toggle() {
		hapticLight();
		ontoggle?.(!open);
	}

	async function toggleRepo(repoId: string, field: 'assigned_only' | 'manual_only' | 'enabled', currentValue: number) {
		hapticLight();
		try {
			await fetch(`/api/monitored-repos/${repoId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ [field]: !currentValue }),
			});
			invalidateAll();
		} catch (e) {
			console.error(`Failed to toggle ${field}:`, e);
		}
	}

	async function deleteRepo(repoId: string) {
		hapticHeavy();
		try {
			await fetch(`/api/monitored-repos/${repoId}`, { method: 'DELETE' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to delete repo:', e);
		}
	}

	async function scanRepo(repoId: string) {
		hapticMedium();
		scanningRepo = repoId;
		try {
			await fetch(`/api/monitored-repos/${repoId}/scan`, { method: 'POST' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to scan repo:', e);
		} finally {
			scanningRepo = null;
		}
	}

	async function scanAll() {
		hapticMedium();
		scanningAll = true;
		try {
			await fetch('/api/monitored-repos/scan', { method: 'POST' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to scan all repos:', e);
		} finally {
			scanningAll = false;
		}
	}

	async function togglePrPoller() {
		hapticMedium();
		const action = prPollerRunning ? 'stop' : 'start';
		try {
			await fetch('/api/monitored-repos/poller', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action }),
			});
			invalidateAll();
		} catch (e) {
			console.error('Failed to toggle PR poller:', e);
		}
	}

	function formatInterval(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m`;
	}
</script>

<!-- Collapsible header -->
<div
	class="flex items-center gap-2 px-1 py-1.5 cursor-pointer select-none"
	role="button"
	tabindex="0"
	onclick={toggle}
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
>
	<span class="inline-flex text-sm opacity-50 transition-transform {open ? 'rotate-90' : ''}">
		<Icon name="chevron-right" class="w-3.5 h-3.5" />
	</span>
	<span class="text-sm font-semibold">PR Monitor</span>
	{#if repos.length > 0}
		<span class="badge badge-xs badge-ghost">{repos.length}</span>
	{/if}
	<!-- Poller status dot (visible when collapsed) -->
	{#if !open}
		{#if prPollerRunning}
			<span class="relative flex h-1.5 w-1.5">
				<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
				<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
			</span>
		{/if}
	{/if}
</div>

<!-- Expanded panel -->
{#if open}
	<div class="rounded-lg border border-base-300 bg-base-200/30 p-3 mt-1">
		<!-- Controls row -->
		<div class="flex items-center justify-between mb-3">
			<div class="flex items-center gap-1">
				<!-- PR Poller toggle -->
				<button
					class="btn btn-xs {prPollerRunning ? 'btn-success' : 'btn-ghost'}"
					onclick={togglePrPoller}
					title={prPollerRunning
						? `PR poller running (every ${formatInterval(pollIntervalMs)}, concurrency ${concurrency}) — click to stop`
						: 'PR poller stopped — click to start'}
				>
					{#if prPollerRunning}
						<span class="relative flex h-1.5 w-1.5">
							<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-content opacity-75"></span>
							<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-success-content"></span>
						</span>
						Poll On
					{:else}
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-base-content/20"></span>
						Poll Off
					{/if}
				</button>
				<span class="text-xs text-base-content/40 hidden sm:inline">
					{formatInterval(pollIntervalMs)} · max {concurrency}
				</span>
			</div>
			<div class="flex items-center gap-1">
				<!-- Add repo -->
				{#if onaddrepo}
					<button
						class="btn btn-xs btn-ghost gap-0.5"
						onclick={(e) => { e.stopPropagation(); hapticMedium(); onaddrepo?.(); }}
						title="Add a repo to monitor"
					>
						<Icon name="plus" class="w-3 h-3" /> Add
					</button>
				{/if}
				<!-- Scan all -->
				<button
					class="btn btn-xs btn-ghost gap-0.5"
					onclick={scanAll}
					disabled={scanningAll || repos.length === 0}
					title="Scan all enabled repos now"
				>
					{#if scanningAll}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						<Icon name="refresh" class="w-3 h-3" />
					{/if}
					Scan All
				</button>
			</div>
		</div>

		<!-- Repo list -->
		{#if repos.length === 0}
			<div class="py-3 text-center">
				<p class="text-sm text-base-content/50">No repos monitored yet.</p>
				{#if onaddrepo}
					<button
						class="btn btn-sm btn-primary mt-2 gap-1"
						onclick={() => { hapticMedium(); onaddrepo?.(); }}
					>
						<Icon name="plus" class="w-4 h-4" /> Add Repo
					</button>
				{/if}
			</div>
		{:else}
			<div class="flex flex-col gap-1.5">
				{#each repos as repo (repo.id)}
					<SwipeToDelete ondelete={() => deleteRepo(repo.id)}>
						<div class="flex items-center gap-2 px-3 py-2 rounded-md bg-base-100/50 border border-base-300/50 {!repo.enabled ? 'opacity-50' : ''}">
							<!-- Repo name -->
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">
									{repo.owner}/{repo.name}
								</div>
								{#if repo.local_path}
									<div class="text-xs text-base-content/40 truncate">{repo.local_path}</div>
								{/if}
							</div>

							<!-- Toggle badges -->
							<button
								class="badge badge-xs cursor-pointer {repo.assigned_only ? 'badge-primary' : 'badge-ghost'}"
								onclick={() => toggleRepo(repo.id, 'assigned_only', repo.assigned_only)}
								title={repo.assigned_only ? 'Assigned to me only — click to toggle' : 'All PRs — click to filter by assignment'}
							>
								{repo.assigned_only ? 'Mine' : 'All'}
							</button>

							<button
								class="badge badge-xs cursor-pointer {repo.manual_only ? 'badge-warning' : 'badge-success'}"
								onclick={() => toggleRepo(repo.id, 'manual_only', repo.manual_only)}
								title={repo.manual_only ? 'Manual scan only — click to enable auto-poll' : 'Auto-polling — click to set manual only'}
							>
								{repo.manual_only ? 'Manual' : 'Auto'}
							</button>

							<button
								class="badge badge-xs cursor-pointer {repo.enabled ? 'badge-success' : 'badge-error'}"
								onclick={() => toggleRepo(repo.id, 'enabled', repo.enabled)}
								title={repo.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
							>
								{repo.enabled ? 'On' : 'Off'}
							</button>

							<!-- Scan button -->
							<button
								class="btn btn-xs btn-ghost btn-circle"
								onclick={() => scanRepo(repo.id)}
								disabled={scanningRepo === repo.id || !repo.enabled}
								title="Scan this repo now"
							>
								{#if scanningRepo === repo.id}
									<span class="loading loading-spinner loading-xs"></span>
								{:else}
									<Icon name="search" class="w-3 h-3" />
								{/if}
							</button>
						</div>
					</SwipeToDelete>
				{/each}
			</div>
		{/if}
	</div>
{/if}
