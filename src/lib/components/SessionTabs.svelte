<script lang="ts">
	import NewSessionModal from './NewSessionModal.svelte';

	interface ActiveSession {
		id: string;
		name: string | null;
		firstMessage: string;
		cwd: string;
		model: string | null;
		shortName: string;
	}

	let { currentSessionId }: { currentSessionId: string } = $props();

	let sessions = $state<ActiveSession[]>([]);
	let loading = $state(true);
	let showNewSession = $state(false);

	async function loadActiveSessions() {
		try {
			const res = await fetch('/api/sessions/active');
			if (res.ok) {
				sessions = await res.json();
			}
		} catch (e) {
			console.error('Failed to load active sessions:', e);
		} finally {
			loading = false;
		}
	}

	// Load on mount
	$effect(() => {
		loadActiveSessions();
	});

	// Refresh when SSE notifies of session changes (poll every 30s as lightweight fallback)
	$effect(() => {
		const es = new EventSource('/api/sessions/watch');
		es.onmessage = () => loadActiveSessions();
		const interval = setInterval(loadActiveSessions, 30000);
		return () => {
			es.close();
			clearInterval(interval);
		};
	});

	const label = (s: ActiveSession) => s.name || s.firstMessage || s.shortName || 'Session';

	// Collect recent cwds/models from active sessions for the new session modal
	const currentCwd = $derived(sessions.find((s) => s.id === currentSessionId)?.cwd ?? '');
	const recentCwds = $derived([...new Set(sessions.map((s) => s.cwd))].slice(0, 10));
	const recentModels = $derived(
		[...new Set(sessions.map((s) => s.model).filter(Boolean) as string[])].slice(0, 10)
	);
</script>

{#if !loading}
	<div class="border-t border-base-300 bg-base-200 shrink-0 overflow-x-auto">
		<div class="flex min-w-0">
			{#each sessions as session (session.id)}
				<a
					href="/session/{session.id}"
					class="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs border-r border-base-300 transition-colors max-w-[160px] min-w-[80px]
						{session.id === currentSessionId
							? 'bg-base-100 text-base-content font-semibold border-t-2 border-t-primary'
							: 'text-base-content/60 hover:bg-base-300/50 border-t-2 border-t-transparent'}"
				>
					<span class="h-1.5 w-1.5 rounded-full bg-success flex-shrink-0"></span>
					<span class="truncate">{label(session)}</span>
				</a>
			{/each}
			<button
				class="flex-shrink-0 flex items-center gap-1 px-3 py-2 text-xs border-r border-base-300 text-base-content/40 hover:text-base-content/70 hover:bg-base-300/50 transition-colors border-t-2 border-t-transparent"
				onclick={() => (showNewSession = true)}
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
				</svg>
				<span>New</span>
			</button>
		</div>
	</div>
{/if}

<NewSessionModal
	open={showNewSession}
	defaultCwd={currentCwd}
	{recentCwds}
	{recentModels}
	onclose={() => (showNewSession = false)}
/>
