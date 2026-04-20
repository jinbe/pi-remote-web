<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { timeAgo, shortenHome } from '$lib/utils';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import SwipeToDelete from '$lib/components/SwipeToDelete.svelte';
	import StatusDot from '$lib/components/StatusDot.svelte';
	import AddJobModal from '$lib/components/AddJobModal.svelte';
	import AddReviewJobModal from '$lib/components/AddReviewJobModal.svelte';
	import JobList from '$lib/components/JobList.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { getContext } from 'svelte';
	import { browser } from '$app/environment';
	import PiWordmark from '$lib/components/PiWordmark.svelte';

	let { data } = $props();

	const { theme, toggleTheme } = getContext<{ theme: 'dark' | 'light'; toggleTheme: () => void }>('theme');

	let search = $state('');
	let harnessFilter = $state<'all' | 'pi' | 'claude-code'>('all');
	let showNewSession = $state(false);
	let newSessionCwd = $state('');
	let newSessionHarness = $state<'pi' | 'claude-code'>('pi');
	let expandedProject = $state<string | null>(
		browser ? localStorage.getItem('pi-expanded-project') : null
	);
	let editingDevCommand = $state<string | null>(null);
	let devCommandInput = $state('');
	let creatingForProject = $state<string | null>(null);
	let showAddJob = $state(false);
	let addJobRepo = $state('');
	let addJobHarness = $state<'pi' | 'claude-code'>('pi');
	let showAddReviewJob = $state(false);
	let addReviewJobRepo = $state('');
	let addReviewJobHarness = $state<'pi' | 'claude-code'>('pi');
	let showAllSessionsFor = $state<Set<string>>(new Set());

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

	// Filter by search and harness
	const filtered = $derived.by(() => {
		const q = search.toLowerCase();
		let result = data.sessions;
		if (harnessFilter !== 'all') {
			result = result.filter((s) => (s.harness || 'pi') === harnessFilter);
		}
		if (q) {
			result = result.filter(
				(s) =>
					(s.name?.toLowerCase().includes(q) ?? false) ||
					s.cwd.toLowerCase().includes(q) ||
					s.firstMessage.toLowerCase().includes(q) ||
					(s.model?.toLowerCase().includes(q) ?? false)
			);
		}
		return result;
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

	/** Get the most recently used harness for a given cwd */
	function getLastHarness(cwd: string): 'pi' | 'claude-code' {
		const projectSessions = data.sessions.filter((s) => s.cwd === cwd);
		if (projectSessions.length > 0) return projectSessions[0].harness || 'pi';
		return 'pi';
	}

	function openNewSessionForProject(cwd: string) {
		hapticMedium();
		newSessionCwd = cwd;
		newSessionHarness = getLastHarness(cwd);
		showNewSession = true;
	}

	async function createSessionForProject(cwd: string, harness?: 'pi' | 'claude-code') {
		if (creatingForProject) return;
		hapticMedium();
		creatingForProject = cwd;
		const effectiveHarness = harness || getLastHarness(cwd);
		try {
			const res = await fetch('/api/sessions/new', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd, harness: effectiveHarness })
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

	function openAddJob(repo: string) {
		hapticMedium();
		addJobRepo = repo;
		addJobHarness = getLastHarness(repo);
		showAddJob = true;
	}

	function openAddReviewJob(repo: string) {
		hapticMedium();
		addReviewJobRepo = repo;
		addReviewJobHarness = getLastHarness(repo);
		showAddReviewJob = true;
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="mx-auto max-w-5xl px-4 sm:px-6 py-5 h-full overflow-y-auto"
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
				class="text-base-content/40 text-sm transition-transform duration-150 inline-flex"
				style="transform: rotate({Math.min(pullDistance / PULL_THRESHOLD, 1) * 180}deg);"
			>
				<Icon name="arrow-down" class="w-4 h-4" />
			</span>
		{/if}
	</div>

	<!-- Top bar — generous, structural -->
	<header class="mb-4 flex items-center justify-between gap-4">
		<div class="flex items-center gap-4">
			<PiWordmark height={22} />
			{#if data.jobs.length > 0 || data.pollerRunning}
				<span class="hidden sm:inline-block w-px h-4 bg-base-300"></span>
				<a href="/jobs" class="btn btn-sm btn-ghost gap-1" title="View all jobs">
					<span class="opacity-60 inline-flex"><Icon name="hammer" class="w-4 h-4" /></span>
					<span>Jobs</span>
					{#if data.jobs.filter((j: any) => ['queued', 'claimed', 'running'].includes(j.status)).length > 0}
						<span class="bg-accent text-accent-content text-[10px] font-semibold px-1.5 py-0.5 leading-none">{data.jobs.filter((j: any) => ['queued', 'claimed', 'running'].includes(j.status)).length}</span>
					{/if}
				</a>
			{/if}
		</div>
		<div class="flex gap-2 items-center">
			{#if hasAnythingRunning}
				<button
					class="btn btn-sm btn-outline border-accent text-accent hover:bg-accent hover:text-accent-content"
					onclick={stopAllSessions}
					disabled={stoppingAll}
				>
					{#if stoppingAll}
						<span class="loading loading-spinner loading-xs"></span>
					{/if}
					<span class="hidden sm:inline">Stop all · {activeSet.size + runningDevSet.size}</span>
					<span class="sm:hidden">Stop</span>
				</button>
			{/if}
			<button class="btn btn-sm btn-primary gap-1" onclick={() => { hapticMedium(); newSessionCwd = ''; newSessionHarness = data.sessions[0]?.harness || 'pi'; showNewSession = true; }}><Icon name="plus" class="w-4 h-4" /> New session</button>
			<!-- Kebab menu -->
			<div class="dropdown dropdown-end">
				<div tabindex="0" role="button" class="btn btn-sm btn-ghost btn-square" aria-label="More actions">
					<Icon name="more-vertical" class="w-5 h-5" />
				</div>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul tabindex="0" class="dropdown-content menu bg-base-200 z-50 w-44 p-2 border border-base-300">
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
				</ul>
			</div>
		</div>
	</header>

	<!-- Sub-toolbar — workspace context + harness filter -->
	<div class="mb-3 flex items-center justify-between gap-3 border-y border-base-300 py-2.5">
		<div class="flex items-baseline gap-3 min-w-0">
			<span class="text-[10.5px] font-medium uppercase tracking-[0.12em] text-base-content-faint">Workspace</span>
			<span class="text-xs text-base-content-subtle">
				{projectGroups.length} {projectGroups.length === 1 ? 'repo' : 'repos'} · {filtered.length} sessions
				{#if streamingSet.size > 0}
					· <span class="text-accent font-medium">{streamingSet.size} streaming</span>
				{/if}
			</span>
		</div>
		<div class="flex gap-2 items-center">
			<input
				type="text"
				placeholder="Search…"
				class="input input-sm w-32 sm:w-48"
				bind:value={search}
			/>
			<div class="flex border border-base-300">
				<button
					class="px-2.5 py-0.5 text-xs {harnessFilter === 'all' ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'}"
					onclick={() => { hapticLight(); harnessFilter = 'all'; }}
				>All</button>
				<span class="w-px bg-base-300"></span>
				<button
					class="px-2.5 py-0.5 text-xs {harnessFilter === 'pi' ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'}"
					onclick={() => { hapticLight(); harnessFilter = 'pi'; }}
				>π</button>
				<span class="w-px bg-base-300"></span>
				<button
					class="px-2.5 py-0.5 text-xs {harnessFilter === 'claude-code' ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'}"
					onclick={() => { hapticLight(); harnessFilter = 'claude-code'; }}
				>◆</button>
			</div>
		</div>
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
		<div class="flex flex-col">
			{#each projectGroups as group (group.cwd)}
				<article class="project-card border-b border-base-300 {expandedProjects.has(group.cwd) ? 'bg-base-200' : ''}">
					<!-- Project header -->
					<div
						class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-base-300/30 transition-colors cursor-pointer"
						role="button"
						tabindex="0"
						onclick={() => toggleCollapse(group.cwd)}
						aria-label="Toggle project {group.shortName}"
						onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapse(group.cwd); }}
					>
						<span class="inline-flex text-sm text-base-content-faint transition-transform {expandedProjects.has(group.cwd) ? 'rotate-90' : ''}"><Icon name="chevron-right" class="w-3.5 h-3.5" /></span>
						<div class="flex items-baseline gap-3 min-w-0 flex-1">
							<span class="font-medium text-[15px] truncate">{group.shortName}</span>
							<span class="hidden md:inline font-mono text-xs text-base-content-faint truncate">{shortenHome(group.cwd)}</span>
						</div>
						{#if group.hasStreaming}
							<span class="hidden sm:inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent">
								<StatusDot status="streaming" />
								Streaming
							</span>
							<span class="sm:hidden"><StatusDot status="streaming" size="md" /></span>
						{:else if group.hasActive}
							<span class="hidden sm:inline-flex items-center gap-1.5 text-[11.5px] font-medium text-secondary">
								<StatusDot status="idle" />
								Idle
							</span>
							<span class="sm:hidden"><StatusDot status="idle" size="md" /></span>
						{/if}
						{#if group.devServerRunning}
							<span class="hidden sm:inline-flex items-center gap-1.5 text-[11.5px] text-base-content-subtle">
								<StatusDot status="info" />
								Dev
							</span>
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
									<span class="text-info"><Icon name="stop" class="w-4 h-4" /></span>
								{:else}
									<span class="opacity-50"><Icon name="play" class="w-4 h-4" /></span>
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
									<button onclick={(e) => { e.stopPropagation(); createSessionForProject(group.cwd, 'pi'); }} disabled={creatingForProject === group.cwd}>
										<span class="opacity-70">π</span> New pi Session
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); createSessionForProject(group.cwd, 'claude-code'); }} disabled={creatingForProject === group.cwd}>
										<span class="opacity-70">◆</span> New Claude Session
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); openAddJob(group.cwd); }}>
										<span class="opacity-70 inline-flex"><Icon name="hammer" class="w-4 h-4" /></span>
										New Task Job
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); openAddReviewJob(group.cwd); }}>
										<span class="opacity-70 inline-flex"><Icon name="search" class="w-4 h-4" /></span>
										New Review Job
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); startEditDevCommand(group.cwd, group.devCommand); }}>
										<span class="opacity-70 inline-flex"><Icon name="cog" class="w-4 h-4" /></span>
										Configure Dev
									</button>
								</li>
								<li>
									<button onclick={(e) => { e.stopPropagation(); toggleFavorite(group.cwd); }}>
										{#if group.isFavorite}
											<span class="text-warning inline-flex"><Icon name="star-filled" class="w-4 h-4" /></span>
											Unfavorite
										{:else}
											<span class="opacity-50 inline-flex"><Icon name="star-outline" class="w-4 h-4" /></span>
											Favourite
										{/if}
									</button>
								</li>
							</ul>
						</div>

						<!-- Desktop: inline buttons -->
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); openAddJob(group.cwd); }}
							title="New task job for {group.shortName}"
							aria-label="New task job"
						>
							<span class="opacity-50 text-xs inline-flex items-center gap-0.5"><Icon name="hammer" class="w-3 h-3" /> Task</span>
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); openAddReviewJob(group.cwd); }}
							title="New review job for {group.shortName}"
							aria-label="New review job"
						>
							<span class="opacity-50 text-xs inline-flex items-center gap-0.5"><Icon name="search" class="w-3 h-3" /> Review</span>
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); startEditDevCommand(group.cwd, group.devCommand); }}
							title={group.devCommand ? `Dev: ${group.devCommand} (click to edit)` : 'Configure dev command'}
							aria-label="Configure dev command"
						>
							<span class="opacity-40"><Icon name="cog" class="w-4 h-4" /></span>
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); openNewSessionForProject(group.cwd); }}
							title="New session in {group.shortName}"
							aria-label="New session"
						>
							<span class="opacity-50"><Icon name="plus" class="w-4 h-4" /></span>
						</button>
						<button
							class="hidden md:inline-flex btn btn-ghost btn-xs"
							onclick={(e: MouseEvent) => { e.stopPropagation(); toggleFavorite(group.cwd); }}
							title={group.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
						>
							{#if group.isFavorite}
								<span class="text-warning"><Icon name="star-filled" class="w-4 h-4" /></span>
							{:else}
								<span class="opacity-30"><Icon name="star-outline" class="w-4 h-4" /></span>
							{/if}
						</button>
					</div>

					<!-- Project path subtitle (mobile only — desktop shows it inline) -->
					{#if group.devCommand || true}
						<div class="md:hidden px-4 -mt-1 pb-2 text-xs text-base-content-faint truncate font-mono">
							{shortenHome(group.cwd)}
							{#if group.devCommand && !editingDevCommand}
								<span class="ml-2 text-base-content-faint">· {group.devCommand}</span>
							{/if}
						</div>
					{/if}

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
								<Icon name="close" class="w-3.5 h-3.5" />
							</button>
						</div>
					{/if}

					<!-- Sessions list -->
					{#if expandedProjects.has(group.cwd)}
						{@const activeSessions = group.sessions.filter((s) => activeSet.has(s.id))}
						{@const inactiveSessions = group.sessions.filter((s) => !activeSet.has(s.id))}
						{@const showingAll = showAllSessionsFor.has(group.cwd)}
						{@const visibleSessions = showingAll ? group.sessions : activeSessions}
						<div class="px-4 pb-4">
							<div class="flex items-center justify-between py-2">
								<span class="text-[10.5px] font-medium uppercase tracking-[0.12em] text-base-content-faint">Sessions · {visibleSessions.length}</span>
								{#if inactiveSessions.length > 0}
									<button
										class="text-[11px] text-base-content-faint hover:text-base-content-subtle"
										onclick={(e) => {
											e.stopPropagation();
											hapticLight();
											const next = new Set(showAllSessionsFor);
											if (showingAll) next.delete(group.cwd);
											else next.add(group.cwd);
											showAllSessionsFor = next;
										}}
									>
										{showingAll ? `Hide ${inactiveSessions.length} inactive` : `Show ${inactiveSessions.length} inactive`}
									</button>
								{/if}
							</div>
							<div class="border border-base-300 bg-base-100">
								{#if visibleSessions.length === 0 && inactiveSessions.length > 0}
									<div class="px-4 py-3 text-sm text-base-content-faint">
										No active sessions
									</div>
								{/if}
								{#each visibleSessions as session, i (session.id)}
									<SwipeToDelete
										ondelete={() => deleteSession(session.id)}
										disabled={activeSet.has(session.id)}
									>
										<a
											href="/session/{session.id}"
											class="group grid grid-cols-[14px_1fr_auto_auto_auto] gap-3.5 items-center px-4 py-3 hover:bg-base-200 transition-colors {i > 0 ? 'border-t border-base-300' : ''}"
										>
											<StatusDot
												status={streamingSet.has(session.id) ? 'streaming' : activeSet.has(session.id) ? 'idle' : 'inactive'}
											/>
											<div class="min-w-0">
												<div class="truncate text-[13.5px] font-medium">
													{session.name || session.firstMessage || 'Empty session'}
												</div>
												<div class="mt-0.5 text-[11.5px] text-base-content-subtle">
													{timeAgo(session.lastModified)} · {session.messageCount} msgs
												</div>
											</div>
											{#if session.model}
												<span class="hidden sm:inline-flex font-mono text-[10.5px] text-base-content-subtle border border-base-300 px-1.5 py-0.5 leading-none">{session.model}</span>
											{:else}
												<span></span>
											{/if}
											<span class="text-[11px] font-semibold text-base-content-subtle font-mono w-4 text-center" title={session.harness === 'claude-code' ? 'Claude Code' : 'pi'}>
												{session.harness === 'claude-code' ? '◆' : 'π'}
											</span>
											<span class="text-base-content-faint inline-flex"><Icon name="chevron-right" class="w-3.5 h-3.5" /></span>
										</a>
									</SwipeToDelete>
								{/each}
							</div>
						</div>

						<!-- Jobs for this project -->
						{#if data.jobs.filter((j: any) => j.repo === group.cwd).length > 0}
							<div class="px-4 pb-4">
								<div class="text-[10.5px] font-medium uppercase tracking-[0.12em] text-base-content-faint py-2">Jobs · {data.jobs.filter((j: any) => j.repo === group.cwd).length}</div>
								<div class="border border-base-300 bg-base-100">
									<JobList jobs={data.jobs} repo={group.cwd} />
								</div>
							</div>
						{/if}
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>

<NewSessionModal
	open={showNewSession}
	defaultCwd={newSessionCwd}
	{recentCwds}
	defaultHarness={newSessionHarness}
	onclose={() => (showNewSession = false)}
/>

<AddJobModal
	open={showAddJob}
	defaultRepo={addJobRepo}
	defaultHarness={addJobHarness}
	onclose={() => (showAddJob = false)}
/>

<AddReviewJobModal
	open={showAddReviewJob}
	defaultRepo={addReviewJobRepo}
	defaultHarness={addReviewJobHarness}
	onclose={() => (showAddReviewJob = false)}
/>

