<script lang="ts">
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

	// Refresh when SSE notifies of session changes (poll every 10s as lightweight fallback)
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
</script>

{#if !loading && sessions.length > 1}
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
		</div>
	</div>
{/if}
