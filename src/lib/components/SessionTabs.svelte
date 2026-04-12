<script lang="ts">
	import NewSessionModal from './NewSessionModal.svelte';
	import StatusDot from './StatusDot.svelte';
	import { hapticLight, hapticHeavy } from '$lib/haptics';

	interface ActiveSession {
		id: string;
		name: string | null;
		firstMessage: string;
		cwd: string;
		model: string | null;
		shortName: string;
		isStreaming: boolean;
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

	async function stopSession(sessionId: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		hapticHeavy();
		await fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
		loadActiveSessions();
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
	<div class="border-t border-base-300 bg-base-200 shrink-0 overflow-x-auto pb-[env(safe-area-inset-bottom)]">
		<div class="flex min-w-0">
			{#each sessions as session (session.id)}
				<a
					href="/session/{session.id}"
					onclick={() => hapticLight()}
					class="group/tab flex-shrink-0 flex items-center gap-1.5 pl-3 pr-1.5 py-2 text-xs border-r border-base-300 transition-colors max-w-[180px] min-w-[80px]
						{session.id === currentSessionId
							? 'bg-base-100 text-base-content font-semibold border-t-2 border-t-primary'
							: 'text-base-content-muted hover:bg-base-300/50 border-t-2 border-t-transparent'}"
				>
					<StatusDot status={session.isStreaming ? 'streaming' : 'idle'} size="sm" />
					<span class="truncate flex-1">{label(session)}</span>
					<button
						class="flex-shrink-0 rounded-full w-5 h-5 flex items-center justify-center text-[10px] opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 hover:bg-base-content/10 transition-opacity"
						onclick={(e) => stopSession(session.id, e)}
						aria-label="Stop session {label(session)}"
					>
						✕
					</button>
				</a>
			{/each}
			<button
				class="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs border-r border-base-300 text-base-content-faint hover:text-base-content/70 hover:bg-base-300/50 transition-colors border-t-2 border-t-transparent"
				onclick={() => { hapticLight(); showNewSession = true; }}
				aria-label="New session"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
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
	onclose={() => (showNewSession = false)}
/>

<style>
	/* On touch devices, always show close buttons since there's no hover */
	@media (hover: none) {
		:global(.group\/tab) button {
			opacity: 0.4 !important;
		}
	}
</style>
