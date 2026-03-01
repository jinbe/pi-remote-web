<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { timeAgo } from '$lib/utils';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';

	let { data } = $props();

	let search = $state('');
	let showNewSession = $state(false);
	let expandedProjects = $state<Set<string>>(new Set());
	let editingDevCommand = $state<string | null>(null);
	let devCommandInput = $state('');

	const recentCwds = $derived(
		[...new Set(data.sessions.map((s) => s.cwd))].slice(0, 10)
	);
	const recentModels = $derived(
		[...new Set(data.sessions.map((s) => s.model).filter(Boolean) as string[])].slice(0, 10)
	);

	const activeSet = $derived(new Set(data.activeSessionIds));
	const favSet = $derived(new Set(data.favoriteProjects));
	const devCommandsMap = $derived(data.devCommands as Record<string, string>);
	const runningDevSet = $derived(new Set(data.runningDevServers as string[]));

	// Filter by search
	const filtered = $derived.by(() => {
		const q = search.toLowerCase();
		if (!q) return data.sessions;
		return data.sessions.filter(
			(s) =>
				(s.name?.toLowerCase().includes(q) ?? false) ||
				s.cwd.toLowerCase().includes(q) ||
				s.firstMessage.toLowerCase().includes(q) ||
				(s.model?.toLowerCase().includes(q) ?? false)
		);
	});

	// Group by project (cwd), sorted: favorites first, then by most recent session
	interface ProjectGroup {
		cwd: string;
		shortName: string;
		isFavorite: boolean;
		hasActive: boolean;
		devCommand: string | null;
		devServerRunning: boolean;
		latestModified: string;
		sessions: typeof data.sessions;
	}

	const projectGroups = $derived.by(() => {
		const groups = new Map<string, typeof data.sessions>();
		for (const s of filtered) {
			const list = groups.get(s.cwd);
			if (list) list.push(s);
			else groups.set(s.cwd, [s]);
		}

		const result: ProjectGroup[] = [];
		for (const [cwd, sessions] of groups) {
			const hasActive = sessions.some((s) => activeSet.has(s.id));
			result.push({
				cwd,
				shortName: cwd.split('/').filter(Boolean).slice(-2).join('/'),
				isFavorite: favSet.has(cwd),
				hasActive,
				devCommand: devCommandsMap[cwd] ?? null,
				devServerRunning: runningDevSet.has(cwd),
				latestModified: sessions[0]?.lastModified ?? '',
				sessions
			});
		}

		// Sort: favorites first (active favs first within favs), then by recency
		result.sort((a, b) => {
			if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
			if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
			return b.latestModified.localeCompare(a.latestModified);
		});

		return result;
	});

	function toggleCollapse(cwd: string) {
		const next = new Set(expandedProjects);
		if (next.has(cwd)) next.delete(cwd);
		else next.add(cwd);
		expandedProjects = next;
	}

	async function toggleFavorite(cwd: string) {
		const action = favSet.has(cwd) ? 'remove' : 'add';
		await fetch('/api/favorites', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd, action })
		});
		invalidateAll();
	}

	async function createSessionForProject(cwd: string) {
		try {
			const res = await fetch('/api/sessions/new', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd })
			});
			if (res.ok) {
				const { sessionId } = await res.json();
				window.location.href = `/session/${sessionId}`;
			}
		} catch (e) {
			console.error('Failed to create session:', e);
		}
	}

	const hasActiveSessions = $derived(activeSet.size > 0);
	const hasAnythingRunning = $derived(activeSet.size > 0 || runningDevSet.size > 0);
	let stoppingAll = $state(false);

	async function stopAllSessions() {
		const parts = [];
		if (activeSet.size > 0) parts.push(`${activeSet.size} session(s)`);
		if (runningDevSet.size > 0) parts.push(`${runningDevSet.size} dev server(s)`);
		if (!confirm(`Stop all ${parts.join(' and ')}?`)) return;
		stoppingAll = true;
		try {
			await fetch('/api/sessions/stop-all', { method: 'POST' });
			invalidateAll();
		} catch (e) {
			console.error('Failed to stop all:', e);
		} finally {
			stoppingAll = false;
		}
	}

	async function toggleDevServer(cwd: string, devCommand: string | null) {
		if (runningDevSet.has(cwd)) {
			await fetch('/api/dev-server', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'stop', cwd })
			});
		} else {
			if (!devCommand) {
				// Prompt to configure
				editingDevCommand = cwd;
				devCommandInput = '';
				return;
			}
			await fetch('/api/dev-server', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'start', cwd, command: devCommand })
			});
		}
		invalidateAll();
	}

	function startEditDevCommand(cwd: string, currentCommand: string | null) {
		editingDevCommand = cwd;
		devCommandInput = currentCommand ?? '';
	}

	async function saveDevCommand() {
		if (!editingDevCommand) return;
		const cwd = editingDevCommand;
		const command = devCommandInput.trim() || null;
		await fetch('/api/dev-server', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'configure', cwd, command })
		});
		editingDevCommand = null;
		devCommandInput = '';
		invalidateAll();
	}

	async function saveAndStartDevServer() {
		if (!editingDevCommand || !devCommandInput.trim()) return;
		const cwd = editingDevCommand;
		const command = devCommandInput.trim();
		await fetch('/api/dev-server', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'start', cwd, command })
		});
		editingDevCommand = null;
		devCommandInput = '';
		invalidateAll();
	}

	// Auto-refresh via SSE
	$effect(() => {
		const es = new EventSource('/api/sessions/watch');
		es.onmessage = () => invalidateAll();
		return () => es.close();
	});
</script>

<div class="mx-auto max-w-3xl px-4 py-6 h-full overflow-y-auto">
	<div class="mb-6 flex items-center justify-between">
		<h1 class="text-2xl font-bold">Pi Sessions</h1>
		<div class="flex gap-2">
			{#if hasAnythingRunning}
				<button
					class="btn btn-sm btn-error"
					onclick={stopAllSessions}
					disabled={stoppingAll}
				>
					{#if stoppingAll}
						<span class="loading loading-spinner loading-xs"></span>
					{/if}
					Stop All ({activeSet.size + runningDevSet.size})
				</button>
			{/if}
			<button class="btn btn-sm btn-primary" onclick={() => (showNewSession = true)}>+ New</button>
			<button class="btn btn-sm btn-ghost" onclick={() => invalidateAll()}>↻</button>
		</div>
	</div>

	<!-- Search -->
	<div class="mb-4">
		<input
			type="text"
			placeholder="Search sessions..."
			class="input input-sm w-full"
			bind:value={search}
		/>
	</div>

	<!-- Project groups -->
	{#if projectGroups.length === 0}
		<div class="py-12 text-center text-base-content/50">
			{#if data.sessions.length === 0}
				<p class="text-lg">No sessions found</p>
				<p class="text-sm">Start a Pi session to see it here.</p>
			{:else}
				<p>No sessions match "{search}"</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			{#each projectGroups as group (group.cwd)}
				<div class="rounded-lg border border-base-300 bg-base-200/50 overflow-hidden">
					<!-- Project header -->
					<div
						class="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-base-300/50 transition-colors cursor-pointer"
						role="button"
						tabindex="0"
						onclick={() => toggleCollapse(group.cwd)}
						onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapse(group.cwd); }}
					>
						<span class="text-xs opacity-50 transition-transform {expandedProjects.has(group.cwd) ? 'rotate-90' : ''}">▶</span>
						<span class="font-semibold flex-1 truncate">{group.shortName}</span>
						{#if group.hasActive}
							<span class="badge badge-success badge-xs">active</span>
						{/if}
						{#if group.devServerRunning}
							<span class="badge badge-info badge-xs">dev</span>
						{/if}
						<!-- Dev server toggle -->
						{#if group.devCommand || group.devServerRunning}
							<button
								class="btn btn-ghost btn-xs"
								onclick={(e: MouseEvent) => { e.stopPropagation(); toggleDevServer(group.cwd, group.devCommand); }}
								title={group.devServerRunning ? 'Stop dev server' : `Start dev server (${group.devCommand})`}
							>
								{#if group.devServerRunning}
									<span class="text-info">⏹</span>
								{:else}
									<span class="opacity-50">▷</span>
								{/if}
							</button>
						{/if}
						<!-- Configure dev command -->
						<button
							class="btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); startEditDevCommand(group.cwd, group.devCommand); }}
							title={group.devCommand ? `Dev: ${group.devCommand} (click to edit)` : 'Configure dev command'}
						>
							<span class="opacity-40 text-xs">⚙</span>
						</button>
						<button
							class="btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); createSessionForProject(group.cwd); }}
							title="New session in {group.shortName}"
						>
							<span class="opacity-50">+</span>
						</button>
						<button
							class="btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); toggleFavorite(group.cwd); }}
							title={group.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
						>
							{#if group.isFavorite}
								<span class="text-warning">★</span>
							{:else}
								<span class="opacity-30">☆</span>
							{/if}
						</button>
					</div>

					<!-- Project path subtitle -->
					<div class="px-4 -mt-1 pb-2 text-xs text-base-content/40 truncate">
						{group.cwd}
						{#if group.devCommand && !editingDevCommand}
							<span class="ml-2 text-base-content/30">· {group.devCommand}</span>
						{/if}
					</div>

					<!-- Dev command editor (inline) -->
					{#if editingDevCommand === group.cwd}
						<div class="px-4 pb-3 flex items-center gap-2" onclick={(e: MouseEvent) => e.stopPropagation()}>
							<input
								type="text"
								class="input input-xs input-bordered flex-1"
								placeholder="e.g. npm run dev"
								bind:value={devCommandInput}
								onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') saveAndStartDevServer(); if (e.key === 'Escape') editingDevCommand = null; }}
							/>
							<button class="btn btn-xs btn-primary" onclick={saveAndStartDevServer} disabled={!devCommandInput.trim()}>
								Save & Start
							</button>
							<button class="btn btn-xs btn-ghost" onclick={saveDevCommand}>
								Save
							</button>
							<button class="btn btn-xs btn-ghost" onclick={() => editingDevCommand = null}>
								✕
							</button>
						</div>
					{/if}

					<!-- Sessions list -->
					{#if expandedProjects.has(group.cwd)}
						<div class="border-t border-base-300">
							{#each group.sessions as session, i (session.id)}
								<a
									href="/session/{session.id}"
									class="flex items-start gap-3 px-4 py-3 hover:bg-base-300/50 transition-colors {i > 0 ? 'border-t border-base-300/50' : ''}"
								>
									<div
										class="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full {activeSet.has(session.id)
											? 'bg-success'
											: 'bg-base-content/20'}"
									></div>
									<div class="min-w-0 flex-1">
										<div class="truncate text-sm font-medium">
											{session.name || session.firstMessage || 'Empty session'}
										</div>
										<div class="mt-0.5 flex items-center gap-2 text-xs text-base-content/40">
											<span>{timeAgo(session.lastModified)}</span>
											<span>· {session.messageCount} msgs</span>
											{#if session.model}
												<span class="badge badge-xs badge-ghost">{session.model}</span>
											{/if}
										</div>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<NewSessionModal
	open={showNewSession}
	{recentCwds}
	{recentModels}
	onclose={() => (showNewSession = false)}
/>
