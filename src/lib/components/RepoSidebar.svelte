<script lang="ts">
	import StatusDot from './StatusDot.svelte';
	import PiWordmark from './PiWordmark.svelte';
	import Icon from './Icon.svelte';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import { timeAgo, shortenHome } from '$lib/utils';
	import { goto, invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { getContext, untrack } from 'svelte';

	interface SidebarSession {
		id: string;
		name: string | null;
		firstMessage: string;
		lastModified: string;
		messageCount: number;
		model: string | null;
		harness?: string | null;
		isCurrent: boolean;
		isActive: boolean;
		isStreaming: boolean;
	}

	interface SidebarProject {
		cwd: string;
		shortName: string;
		isFavorite: boolean;
		hasActive: boolean;
		hasStreaming: boolean;
		devCommand: string | null;
		devServerRunning: boolean;
		latestModified: string;
		containsCurrent: boolean;
		sessions: SidebarSession[];
	}

	let {
		projects = [],
		currentSessionId = '',
		activeCount = 0,
		activeJobCount = 0,
		mobileOpen = $bindable(false),
		onnewsession,
	}: {
		projects?: SidebarProject[];
		currentSessionId?: string;
		activeCount?: number;
		activeJobCount?: number;
		mobileOpen?: boolean;
		onnewsession?: (cwd?: string) => void;
	} = $props();

	const { theme, toggleTheme } = getContext<{ theme: 'dark' | 'light'; toggleTheme: () => void }>('theme');

	let harnessFilter = $state<'all' | 'pi' | 'claude-code'>('all');
	let stoppingAll = $state(false);

	// Per-project expansion. Single source of truth: `expanded`.
	//
	// Auto-expand rules:
	//   - On first mount, seed from localStorage and add the current project's cwd.
	//   - When the user navigates to a different session (currentSessionId changes),
	//     ensure the new project is expanded — but don't undo any other manual edits.
	//
	// Manual rules:
	//   - `toggleProject` writes directly to `expanded`. Collapsing the current
	//     project sticks (unlike the previous design where a derived re-added it).
	//
	// Loop avoidance: the auto-expand effect keys off `currentSessionId` only
	// (gated by a plain `let lastSeenSessionId` so it isn't reactive), and reads
	// `expanded` inside `untrack` so the write doesn't trigger a self-rerun.
	const STORAGE_KEY = 'pi-sidebar-expanded';

	let expanded = $state<Set<string>>(
		browser
			? (() => {
					let s = new Set<string>();
					try {
						const raw = localStorage.getItem(STORAGE_KEY);
						if (raw) s = new Set<string>(JSON.parse(raw));
					} catch {}
					return s;
				})()
			: new Set<string>()
	);

	let lastSeenSessionId = '';

	$effect(() => {
		const id = currentSessionId; // tracked
		if (id === lastSeenSessionId) return;
		lastSeenSessionId = id;
		const cur = projects.find((p) => p.containsCurrent);
		if (!cur) return;
		untrack(() => {
			if (!expanded.has(cur.cwd)) {
				expanded = new Set([...expanded, cur.cwd]);
			}
		});
	});

	function persistExpanded(next: Set<string>) {
		expanded = next;
		if (browser) {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch {}
		}
	}

	function toggleProject(cwd: string) {
		hapticLight();
		const next = new Set(expanded);
		if (next.has(cwd)) next.delete(cwd);
		else next.add(cwd);
		persistExpanded(next);
	}

	const filteredProjects = $derived.by(() => {
		if (harnessFilter === 'all') return projects;
		return projects
			.map((p) => ({
				...p,
				sessions: p.sessions.filter((s) => (s.harness || 'pi') === harnessFilter),
			}))
			.filter((p) => p.sessions.length > 0);
	});

	function go(id: string) {
		hapticLight();
		mobileOpen = false;
		goto(`/session/${id}`);
	}

	async function stopAll() {
		hapticHeavy();
		if (!confirm(`Stop all ${activeCount} active session(s)?`)) return;
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

	function refresh() {
		hapticLight();
		invalidateAll();
	}
</script>

{#snippet content()}
	<div class="flex flex-col h-full">
		<!-- Brand + Jobs link + close (mobile) -->
		<div class="px-4 pt-4 pb-3 md:pt-5 flex items-center justify-between border-b border-base-300 gap-2">
			<a href="/" class="inline-flex items-center min-w-0" aria-label="All projects">
				<PiWordmark height={20} />
			</a>
			<div class="flex items-center gap-1">
				<a
					href="/jobs"
					class="inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-base-content-subtle hover:bg-base-200 transition-colors"
					title="Jobs"
				>
					<Icon name="hammer" class="w-3.5 h-3.5" />
					<span>Jobs</span>
					{#if activeJobCount > 0}
						<span class="bg-accent text-accent-content text-[9.5px] font-semibold px-1 py-px leading-none">{activeJobCount}</span>
					{/if}
				</a>
				<button
					class="md:hidden btn btn-ghost btn-square btn-sm"
					onclick={() => (mobileOpen = false)}
					aria-label="Close sidebar"
				>
					<Icon name="close" class="w-4 h-4" />
				</button>
			</div>
		</div>

		<!-- Workspace meta + harness filter -->
		<div class="px-4 py-3 md:py-2.5 flex items-center justify-between gap-2 border-b border-base-300">
			<div class="text-[10.5px] font-medium uppercase tracking-[0.12em] text-base-content-faint flex items-center gap-1.5 min-w-0">
				<span>{projects.length} {projects.length === 1 ? 'repo' : 'repos'}</span>
				{#if activeCount > 0}
					<span>·</span>
					<span class="text-accent">{activeCount} live</span>
					<button
						class="ml-1 inline-flex items-center text-accent hover:underline normal-case tracking-normal text-[11px] font-medium disabled:opacity-50"
						onclick={stopAll}
						disabled={stoppingAll}
						title="Stop all active sessions"
					>
						{#if stoppingAll}
							<span class="loading loading-spinner loading-xs"></span>
						{:else}
							stop all
						{/if}
					</button>
				{/if}
			</div>
			<div class="flex border border-base-300 text-[11px] flex-shrink-0">
				{#each (['all', 'pi', 'claude-code'] as const) as v, i}
					<button
						class="px-2 py-0.5 {harnessFilter === v ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'} {i > 0 ? 'border-l border-base-300' : ''}"
						onclick={() => { hapticLight(); harnessFilter = v; }}
					>{v === 'all' ? 'All' : v === 'pi' ? 'π' : '◆'}</button>
				{/each}
			</div>
		</div>

		<!-- Project list -->
		<nav class="flex-1 overflow-y-auto" aria-label="Projects">
			{#if filteredProjects.length === 0}
				<div class="px-4 py-6 text-xs text-base-content-faint text-center">
					No sessions match
				</div>
			{:else}
				{#each filteredProjects as project (project.cwd)}
					{@const isExpanded = expanded.has(project.cwd)}
					<div class="border-b border-base-300/60">
						<!-- Project header -->
						<button
							class="w-full text-left flex items-center gap-2 px-4 py-3 md:py-2.5 hover:bg-base-200 transition-colors"
							onclick={() => toggleProject(project.cwd)}
							aria-expanded={isExpanded}
						>
							<span class="inline-flex text-base-content-faint transition-transform {isExpanded ? 'rotate-90' : ''}">
								<Icon name="chevron-right" class="w-3 h-3" />
							</span>
							<div class="flex-1 min-w-0">
								<div class="text-[12.5px] font-medium truncate flex items-center gap-1.5">
									{#if project.isFavorite}
										<span class="text-accent inline-flex flex-shrink-0"><Icon name="star-filled" class="w-3 h-3" /></span>
									{/if}
									<span class="truncate">{project.shortName}</span>
								</div>
								<div class="font-mono text-[10px] text-base-content-faint truncate mt-0.5">
									{shortenHome(project.cwd)}
								</div>
							</div>
							{#if project.hasStreaming}
								<StatusDot status="streaming" size="sm" />
							{:else if project.hasActive}
								<StatusDot status="idle" size="sm" />
							{/if}
							<span class="text-[10px] text-base-content-faint">{project.sessions.length}</span>
						</button>

						<!-- Sessions inside -->
						{#if isExpanded}
							<div class="pb-1.5">
								{#each project.sessions as s (s.id)}
									<button
										class="w-full text-left grid grid-cols-[8px_1fr_auto] gap-2.5 items-center pl-7 pr-4 py-2.5 md:py-2 transition-colors border-l-2 {s.isCurrent ? 'border-accent bg-base-200' : 'border-transparent hover:bg-base-200/60'}"
										onclick={() => go(s.id)}
										aria-current={s.isCurrent ? 'page' : undefined}
									>
										<StatusDot
											status={s.isStreaming ? 'streaming' : s.isActive ? 'idle' : 'inactive'}
										/>
										<div class="min-w-0">
											<div class="text-[12.5px] truncate {s.isCurrent ? 'font-medium' : 'text-base-content-muted'}">
												{s.name || s.firstMessage || 'Empty session'}
											</div>
											<div class="text-[10px] text-base-content-faint mt-0.5">
												{timeAgo(s.lastModified)} · {s.messageCount}
											</div>
										</div>
										<span class="text-[10px] font-semibold text-base-content-faint font-mono w-3 text-right" title={s.harness === 'claude-code' ? 'Claude Code' : 'pi'}>
											{s.harness === 'claude-code' ? '◆' : 'π'}
										</span>
									</button>
								{/each}
								{#if onnewsession}
									<button
										class="w-full text-left flex items-center gap-2 pl-7 pr-4 py-2 text-[12px] text-base-content-subtle hover:bg-base-200/60 transition-colors"
										onclick={() => { hapticMedium(); onnewsession?.(project.cwd); mobileOpen = false; }}
									>
										<Icon name="plus" class="w-3 h-3" />
										New session in {project.shortName}
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</nav>

		<!-- Footer: New session + Refresh + Theme.
		     Stop all → workspace meta row above. Stop current session → session
		     header kebab (per-session actions live with the session). -->
		<div class="border-t border-base-300 p-2 flex items-center gap-1">
			{#if onnewsession}
				<button
					class="btn btn-sm btn-secondary flex-1 gap-1"
					onclick={() => { hapticMedium(); onnewsession?.(); mobileOpen = false; }}
					title="New session"
				>
					<Icon name="plus" class="w-3.5 h-3.5" />
					<span>New</span>
				</button>
			{/if}

			<button class="btn btn-sm btn-ghost btn-square" onclick={refresh} title="Refresh" aria-label="Refresh">
				<Icon name="refresh" class="w-4 h-4" />
			</button>

			<button
				class="btn btn-sm btn-ghost btn-square"
				onclick={() => { hapticLight(); toggleTheme(); }}
				title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
				aria-label="Toggle theme"
			>
				{#if theme === 'dark'}
					<Icon name="sun" class="w-4 h-4" />
				{:else}
					<Icon name="moon" class="w-4 h-4" />
				{/if}
			</button>
		</div>
	</div>
{/snippet}

<!-- Desktop: persistent left rail -->
<aside class="hidden md:flex flex-col w-[260px] border-r border-base-300 bg-base-100 shrink-0">
	{@render content()}
</aside>

<!-- Mobile: backdrop + overlay drawer -->
{#if mobileOpen}
	<div
		class="md:hidden fixed inset-0 bg-black/40 z-[60]"
		role="presentation"
		onclick={() => (mobileOpen = false)}
		onkeydown={(e) => { if (e.key === 'Escape') mobileOpen = false; }}
	></div>
{/if}
<aside
	class="md:hidden fixed top-0 left-0 bottom-0 w-[320px] max-w-[88vw] bg-base-100 border-r border-base-300 z-[61] mobile-drawer"
	class:open={mobileOpen}
	aria-hidden={!mobileOpen}
	aria-label="Project navigator"
>
	{@render content()}
</aside>

<style>
	.mobile-drawer {
		transform: translateX(-100%);
		transition: transform 240ms cubic-bezier(0.2, 0, 0, 1);
		padding-top: env(safe-area-inset-top);
		padding-left: env(safe-area-inset-left);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.mobile-drawer.open {
		transform: translateX(0);
	}

	@media (prefers-reduced-motion: reduce) {
		.mobile-drawer {
			transition: none;
		}
	}
</style>
