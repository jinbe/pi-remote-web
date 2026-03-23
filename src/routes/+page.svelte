<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { timeAgo, shortenHome } from '$lib/utils';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import SwipeToDelete from '$lib/components/SwipeToDelete.svelte';
	import StatusDot from '$lib/components/StatusDot.svelte';
	import { getContext } from 'svelte';
	import { browser } from '$app/environment';
	import logoSvg from '$lib/assets/logo.svg';

	let { data } = $props();

	const { theme, toggleTheme } = getContext<{ theme: 'dark' | 'light'; toggleTheme: () => void }>('theme');

	let search = $state('');
	let showNewSession = $state(false);
	let expandedProject = $state<string | null>(
		browser ? localStorage.getItem('pi-expanded-project') : null
	);
	let editingDevCommand = $state<string | null>(null);
	let devCommandInput = $state('');
	let creatingForProject = $state<string | null>(null);

	// Persist expanded project to localStorage
	$effect(() => {
		if (browser) {
			if (expandedProject) {
				localStorage.setItem('pi-expanded-project', expandedProject);
			} else {
				localStorage.removeItem('pi-expanded-project');
			}
		}
	});

	// Compat shim: expandedProjects as a derived Set from single expandedProject
	const expandedProjects = $derived(new Set(expandedProject ? [expandedProject] : []));

	const recentCwds = $derived(
		[...new Set(data.sessions.map((s) => s.cwd))].slice(0, 10)
	);
	const recentModels = $derived(
		[...new Set(data.sessions.map((s) => s.model).filter(Boolean) as string[])].slice(0, 10)
	);

	const activeSet = $derived(new Set(data.activeSessionIds));
	const streamingSet = $derived(new Set(data.streamingSessionIds));
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
		hasStreaming: boolean;
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
			const hasStreaming = sessions.some((s) => streamingSet.has(s.id));
			result.push({
				cwd,
				shortName: cwd.split('/').filter(Boolean).slice(-2).join('/'),
				isFavorite: favSet.has(cwd),
				hasActive,
				hasStreaming,
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
		hapticLight();
		expandedProject = expandedProject === cwd ? null : cwd;
	}

	async function toggleFavorite(cwd: string) {
		hapticLight();
		const action = favSet.has(cwd) ? 'remove' : 'add';
		await fetch('/api/favorites', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cwd, action })
		});
		invalidateAll();
	}

	async function createSessionForProject(cwd: string) {
		if (creatingForProject) return;
		hapticMedium();
		creatingForProject = cwd;
		try {
			const res = await fetch('/api/sessions/new', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd })
			});
			if (res.ok) {
				const { sessionId } = await res.json();
				// Store this project as expanded so when returning to dashboard it's open
				if (browser) localStorage.setItem('pi-expanded-project', cwd);
				window.location.href = `/session/${sessionId}`;
			} else {
				creatingForProject = null;
			}
		} catch (e) {
			console.error('Failed to create session:', e);
			creatingForProject = null;
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
		hapticHeavy();
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
		hapticMedium();
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

	async function deleteSession(sessionId: string, e?: MouseEvent) {
		if (e) {
			e.preventDefault();
			e.stopPropagation();
		}
		if (e && !confirm('Delete this session? This cannot be undone.')) return;
		hapticHeavy();
		try {
			await fetch(`/api/sessions/${sessionId}/delete`, { method: 'POST' });
			invalidateAll();
		} catch (err) {
			console.error('Failed to delete session:', err);
		}
	}

	// Pull-to-refresh state
	let pullStartY = $state(0);
	let pullDistance = $state(0);
	let isPulling = $state(false);
	let isRefreshing = $state(false);
	let scrollContainer: HTMLElement | undefined = $state();
	const PULL_THRESHOLD = 80;

	function onPullTouchStart(e: TouchEvent) {
		if (!scrollContainer || scrollContainer.scrollTop > 0 || isRefreshing) return;
		pullStartY = e.touches[0].clientY;
		isPulling = true;
	}

	function onPullTouchMove(e: TouchEvent) {
		if (!isPulling || isRefreshing) return;
		const dy = e.touches[0].clientY - pullStartY;
		if (dy > 0 && scrollContainer && scrollContainer.scrollTop <= 0) {
			pullDistance = Math.min(dy * 0.5, 120); // Dampen the pull
		} else {
			pullDistance = 0;
		}
	}

	async function onPullTouchEnd() {
		if (!isPulling) return;
		isPulling = false;
		if (pullDistance >= PULL_THRESHOLD) {
			hapticMedium();
			isRefreshing = true;
			pullDistance = PULL_THRESHOLD; // Hold at threshold during refresh
			try {
				await invalidateAll();
			} finally {
				isRefreshing = false;
				pullDistance = 0;
			}
		} else {
			pullDistance = 0;
		}
	}

	// Auto-refresh via SSE
	$effect(() => {
		const es = new EventSource('/api/sessions/watch');
		es.onmessage = () => invalidateAll();
		return () => es.close();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="mx-auto max-w-3xl px-4 py-6 h-full overflow-y-auto"
	bind:this={scrollContainer}
	ontouchstart={onPullTouchStart}
	ontouchmove={onPullTouchMove}
	ontouchend={onPullTouchEnd}
>
	<!-- Pull-to-refresh indicator -->
	<div
		class="flex justify-center items-center overflow-hidden transition-all duration-300 ease-out"
		style="height: {pullDistance}px; margin-top: {pullDistance > 0 ? '-0.5rem' : '0'};"
	>
		{#if isRefreshing}
			<span class="loading loading-spinner loading-sm text-primary"></span>
		{:else if pullDistance > 0}
			<span
				class="text-base-content/40 text-sm transition-transform duration-150"
				style="transform: rotate({Math.min(pullDistance / PULL_THRESHOLD, 1) * 180}deg);"
			>
				↓
			</span>
		{/if}
	</div>

	<div class="mb-6 flex items-center justify-between">
		<img src={logoSvg} alt="Pi" class="h-8 w-8 rounded-lg" />
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
					<span class="hidden sm:inline">Stop All ({activeSet.size + runningDevSet.size})</span>
					<span class="sm:hidden">Stop</span>
				</button>
			{/if}
			<button class="btn btn-sm btn-primary" onclick={() => { hapticMedium(); showNewSession = true; }}>+ New</button>
			<button class="btn btn-sm btn-ghost text-base" onclick={() => { hapticLight(); invalidateAll(); }} aria-label="Refresh">↻</button>
			<button class="btn btn-sm btn-ghost btn-circle text-lg" onclick={() => { hapticLight(); toggleTheme(); }} title="Toggle theme" aria-label="Toggle theme">
				{#if theme === 'dark'}☀️{:else}🌙{/if}
			</button>
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
		<div class="py-12 text-center text-base-content-subtle">
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
						aria-label="Toggle project {group.shortName}"
						onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapse(group.cwd); }}
					>
						<span class="text-sm opacity-50 transition-transform {expandedProjects.has(group.cwd) ? 'rotate-90' : ''}">▶</span>
						<span class="font-semibold flex-1 truncate">{group.shortName}</span>
						{#if group.hasStreaming}
							<span class="hidden sm:inline badge badge-warning badge-xs">streaming</span>
							<span class="sm:hidden"><StatusDot status="streaming" size="md" /></span>
						{:else if group.hasActive}
							<span class="hidden sm:inline badge badge-success badge-xs">idle</span>
							<span class="sm:hidden"><StatusDot status="idle" size="md" /></span>
						{/if}
						{#if group.devServerRunning}
							<span class="hidden sm:inline badge badge-info badge-xs">dev</span>
							<span class="sm:hidden"><StatusDot status="info" size="md" /></span>
						{/if}
						<!-- Dev server toggle -->
						{#if group.devCommand || group.devServerRunning}
							<button
								class="btn btn-ghost btn-sm min-w-[2.75rem] min-h-[2.75rem] md:min-w-[2rem] md:min-h-[2rem]"
								onclick={(e: MouseEvent) => { e.stopPropagation(); toggleDevServer(group.cwd, group.devCommand); }}
								title={group.devServerRunning ? 'Stop dev server' : `Start dev server (${group.devCommand})`}
							aria-label={group.devServerRunning ? 'Stop dev server' : 'Start dev server'}
							>
								{#if group.devServerRunning}
									<span class="text-info text-base">⏹</span>
								{:else}
									<span class="opacity-50 text-base">▷</span>
								{/if}
							</button>
						{/if}
						<!-- Mobile: kebab menu for less-frequent actions -->
						<div class="dropdown dropdown-end md:hidden">
							<button tabindex="0" class="btn btn-ghost btn-sm" onclick={(e) => e.stopPropagation()} aria-label="Project actions">
								<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
							</button>
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-50 w-48 p-2 shadow-lg border border-base-300">
								<li>
									<button onclick={(e) => { e.stopPropagation(); createSessionForProject(group.cwd); }} disabled={creatingForProject === group.cwd}>
										{#if creatingForProject === group.cwd}
											<span class="loading loading-spinner loading-sm"></span>
											New Session
										{:else}
											+ New Session
										{/if}
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); startEditDevCommand(group.cwd, group.devCommand); }}>
										<span class="opacity-70">⚙</span>
										Configure Dev
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); toggleFavorite(group.cwd); }}>
										{#if group.isFavorite}
											<span class="text-warning">★</span>
											Unfavorite
										{:else}
											<span class="opacity-50">☆</span>
											Favorite
										{/if}
									</button>
								</li>
							</ul>
						</div>

						<!-- Desktop: inline buttons -->
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); startEditDevCommand(group.cwd, group.devCommand); }}
							title={group.devCommand ? `Dev: ${group.devCommand} (click to edit)` : 'Configure dev command'}
							aria-label="Configure dev command"
						>
							<span class="opacity-40 text-base">⚙</span>
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); createSessionForProject(group.cwd); }}
							title="New session in {group.shortName}"
							aria-label="New session in {group.shortName}"
							disabled={creatingForProject === group.cwd}
						>
							{#if creatingForProject === group.cwd}
								<span class="loading loading-spinner loading-sm"></span>
							{:else}
								<span class="opacity-50 text-base">+</span>
							{/if}
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); toggleFavorite(group.cwd); }}
							title={group.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
						>
							{#if group.isFavorite}
								<span class="text-warning text-base">★</span>
							{:else}
								<span class="opacity-30 text-base">☆</span>
							{/if}
						</button>
					</div>

					<!-- Project path subtitle -->
					<div class="px-4 -mt-1 pb-2 text-xs text-base-content-faint truncate">
						{shortenHome(group.cwd)}
						{#if group.devCommand && !editingDevCommand}
							<span class="ml-2 text-base-content-faint">· {group.devCommand}</span>
						{/if}
					</div>

					<!-- Dev command editor (inline) -->
					{#if editingDevCommand === group.cwd}
						<div class="px-4 pb-3 flex items-center gap-2" role="toolbar" tabindex="-1" onclick={(e: MouseEvent) => e.stopPropagation()} onkeydown={(e: KeyboardEvent) => e.stopPropagation()}>
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
								<SwipeToDelete
									ondelete={() => deleteSession(session.id)}
									disabled={activeSet.has(session.id)}
								>
									<a
										href="/session/{session.id}"
										class="group flex items-start gap-3 px-4 py-3 hover:bg-base-300/50 transition-colors {i > 0 ? 'border-t border-base-300/50' : ''}"
									>
										<div class="mt-1.5">
											<StatusDot
												status={streamingSet.has(session.id) ? 'streaming' : activeSet.has(session.id) ? 'idle' : 'inactive'}
												size="md"
											/>
										</div>
										<div class="min-w-0 flex-1">
											<div class="truncate text-sm font-medium">
												{session.name || session.firstMessage || 'Empty session'}
											</div>
											<div class="mt-0.5 flex items-center gap-2 text-xs text-base-content-faint">
												<span>{timeAgo(session.lastModified)}</span>
												<span>· {session.messageCount} msgs</span>
												{#if session.model}
													<span class="badge badge-xs badge-ghost">{session.model}</span>
												{/if}
											</div>
										</div>
										<button
											class="hidden lg:flex btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 transition-opacity self-center flex-shrink-0 text-error opacity-70"
											onclick={(e: MouseEvent) => deleteSession(session.id, e)}
											title="Delete session"
										>
											✕
										</button>
									</a>
								</SwipeToDelete>
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
