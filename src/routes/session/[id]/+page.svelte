<script lang="ts">
	import ChatBubble from '$lib/components/ChatBubble.svelte';
	import BranchIndicator from '$lib/components/BranchIndicator.svelte';
	import MessageInput from '$lib/components/MessageInput.svelte';
	import ExtensionUIModal from '$lib/components/ExtensionUIModal.svelte';
	import SessionTabs from '$lib/components/SessionTabs.svelte';
	import { timeAgo } from '$lib/utils';
	import { getPathToNode, isAncestorOf, findLeafFrom, getBranchPoints } from '$lib/session-tree';
	import { browser } from '$app/environment';
	import type { AgentMessage, SessionTree, BranchPoint, ExtensionUIRequest, SessionEvent } from '$lib/types';

	let { data } = $props();

	// Messages loaded client-side
	let tree = $state<SessionTree>({ nodes: {}, children: {}, roots: [], leaves: [], currentLeaf: '' });
	let currentMessages = $state<AgentMessage[]>([]);
	let currentLeaf = $state('');
	let loadingMessages = $state(true);

	// Session active state
	let sessionActiveOverride = $state<boolean | null>(null);
	let resuming = $state(false);
	const sessionActive = $derived(sessionActiveOverride ?? data.isActive);

	// Streaming state
	let eventSource: EventSource | null = null;
	let streaming = $state(false);
	let currentAssistantText = $state('');
	let currentThinkingText = $state('');
	let compacting = $state(false);
	let retryInfo = $state<{ attempt: number; maxAttempts: number; delayMs: number } | null>(null);

	// Optimistic message state (Issue 1)
	let pendingUserMessage = $state<string | null>(null);
	let waitingForAgent = $state(false);

	// SSE connection state (Issue 3)
	let sseConnected = $state(false);

	// Session events
	let sessionEvents = $state<SessionEvent[]>([]);
	let showEvents = $state(false);

	// Extension UI
	let extensionUIRequest = $state<ExtensionUIRequest | null>(null);

	// Toasts
	let toasts = $state<{ id: string; message: string; severity: string }[]>([]);

	// Status / Widget
	let statusEntries = $state<Record<string, string>>({});
	let widgetEntries = $state<Record<string, string[]>>({});

	// Scroll
	let chatContainer: HTMLElement | undefined = $state();
	let pageContainer: HTMLElement | undefined = $state();
	let userScrolledUp = $state(false);

	function isNearBottom(): boolean {
		if (!chatContainer) return true;
		const threshold = 100;
		return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < threshold;
	}

	function handleScroll() {
		userScrolledUp = !isNearBottom();
	}

	function scrollToBottom(force = false) {
		if (!chatContainer) return;
		if (!force && userScrolledUp) return;
		requestAnimationFrame(() => {
			chatContainer!.scrollTop = chatContainer!.scrollHeight;
		});
	}

	// Load messages client-side — tail first, then full history
	let hasMore = $state(false);
	let loadingFull = $state(false);

	async function loadTail() {
		loadingMessages = true;
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/messages/tail?count=20`);
			if (res.ok) {
				const result = await res.json();
				currentMessages = result.messages;
				hasMore = result.hasMore;
				scrollToBottom(true);
			}
		} catch (e) {
			console.error('Failed to load tail:', e);
		} finally {
			loadingMessages = false;
		}

		// Backfill full history in background
		loadFullHistory();
	}

	async function loadFullHistory() {
		loadingFull = true;
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/messages`);
			if (res.ok) {
				const result = await res.json();
				tree = result.tree;
				currentLeaf = result.tree.currentLeaf;
				// Preserve scroll position — measure before replacing
				const wasAtBottom = isNearBottom();
				currentMessages = result.messages;
				hasMore = false;
				if (wasAtBottom) scrollToBottom(true);
			}
		} catch (e) {
			console.error('Failed to load full history:', e);
		} finally {
			loadingFull = false;
		}
	}

	// Load session events
	async function loadEvents() {
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/events-log`);
			if (res.ok) {
				const result = await res.json();
				sessionEvents = result.events;
			}
		} catch (e) {
			console.error('Failed to load events:', e);
		}
	}

	// Reload just the full messages (used after agent_end)
	async function reloadMessages() {
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/messages`);
			if (res.ok) {
				const result = await res.json();
				tree = result.tree;
				currentLeaf = result.tree.currentLeaf;
				const wasAtBottom = isNearBottom();
				currentMessages = result.messages;
				if (wasAtBottom) scrollToBottom(true);
				// Clear optimistic message when real messages arrive
				pendingUserMessage = null;
			}
		} catch (e) {
			console.error('Failed to reload messages:', e);
		}
		// Also reload events
		loadEvents();
	}

	// Load on mount and when session changes
	$effect(() => {
		data.sessionId;
		loadTail();
		loadEvents();
	});

	// Remember this project as expanded for dashboard navigation
	$effect(() => {
		if (browser && data.meta.cwd) {
			localStorage.setItem('pi-expanded-project', data.meta.cwd);
		}
	});

	// iOS keyboard handling
	$effect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		function onResize() {
			if (!vv || !pageContainer) return;
			pageContainer.style.height = `${vv.height}px`;
			pageContainer.style.transform = `translateY(${vv.offsetTop}px)`;
			scrollToBottom();
		}

		onResize();
		vv.addEventListener('resize', onResize);
		vv.addEventListener('scroll', onResize);
		return () => {
			vv.removeEventListener('resize', onResize);
			vv.removeEventListener('scroll', onResize);
		};
	});

	// SSE connection with exponential backoff
	let sseRetryDelay = 2000;
	const SSE_MAX_RETRY_DELAY = 30000;

	function connectSSE(sessionId: string) {
		if (eventSource) {
			eventSource.close();
		}

		eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

		eventSource.onmessage = (e) => {
			// Reset backoff on successful message
			sseRetryDelay = 2000;
			sseConnected = true; // Mark as connected on first message
			let event: any;
			try {
				event = JSON.parse(e.data);
			} catch {
				return;
			}

			switch (event.type) {
				case 'stream_sync':
					// Late-join catch-up: server sends accumulated state when we subscribe mid-stream
					streaming = event.isStreaming;
					currentAssistantText = event.assistantText ?? '';
					currentThinkingText = event.thinkingText ?? '';
					scrollToBottom();
					break;
				case 'agent_start':
					streaming = true;
					currentAssistantText = '';
					currentThinkingText = '';
					waitingForAgent = false; // Agent has started, clear waiting state
					// Add to session events
					sessionEvents = [...sessionEvents, {
						id: sessionEvents.length + 1,
						session_id: data.sessionId,
						event_type: 'agent_start',
						timestamp: new Date().toISOString(),
						message_id: null,
						metadata: null
					}];
					break;
				case 'agent_end':
					streaming = false;
					currentAssistantText = '';
					currentThinkingText = '';
					reloadMessages();
					// Add to session events
					sessionEvents = [...sessionEvents, {
						id: sessionEvents.length + 1,
						session_id: data.sessionId,
						event_type: 'agent_end',
						timestamp: new Date().toISOString(),
						message_id: null,
						metadata: null
					}];
					break;
				case 'session_ended':
					streaming = false;
					sessionActiveOverride = false;
					eventSource?.close();
					eventSource = null;
					reloadMessages();
					// Add to session events
					sessionEvents = [...sessionEvents, {
						id: sessionEvents.length + 1,
						session_id: data.sessionId,
						event_type: 'session_ended',
						timestamp: new Date().toISOString(),
						message_id: null,
						metadata: null
					}];
					break;
				case 'message_start':
					if (event.message?.role === 'assistant') {
						// Reload to pick up previously completed messages
						reloadMessages();
						currentAssistantText = '';
						currentThinkingText = '';
					} else if (event.message?.role === 'user') {
						// Clear optimistic message when real user message appears
						pendingUserMessage = null;
					}
					break;
				case 'message_update': {
					const ame = event.assistantMessageEvent;
					if (ame?.type === 'text_delta') {
						currentAssistantText += ame.delta;
						scrollToBottom();
					} else if (ame?.type === 'thinking_delta') {
						currentThinkingText += ame.delta;
					}
					break;
				}
				case 'message_end':
					break;
				case 'tool_execution_start':
				case 'tool_execution_update':
				case 'tool_execution_end':
					scrollToBottom();
					break;
				case 'auto_compaction_start':
					compacting = true;
					// Add to session events
					sessionEvents = [...sessionEvents, {
						id: sessionEvents.length + 1,
						session_id: data.sessionId,
						event_type: 'compaction_start',
						timestamp: new Date().toISOString(),
						message_id: null,
						metadata: null
					}];
					break;
				case 'auto_compaction_end':
					compacting = false;
					// Add to session events
					sessionEvents = [...sessionEvents, {
						id: sessionEvents.length + 1,
						session_id: data.sessionId,
						event_type: 'compaction_end',
						timestamp: new Date().toISOString(),
						message_id: null,
						metadata: null
					}];
					break;
				case 'auto_retry_start':
					retryInfo = {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs
					};
					break;
				case 'auto_retry_end':
					retryInfo = null;
					break;
				case 'extension_error':
					addToast(`Extension error: ${event.error}`, 'error');
					break;
				case 'extension_ui_request':
					if (['input', 'confirm', 'select', 'editor'].includes(event.method)) {
						extensionUIRequest = event;
					} else {
						handleFireAndForget(event);
					}
					break;
			}
		};

		eventSource.onerror = () => {
			eventSource?.close();
			eventSource = null;
			sseConnected = false; // Mark as disconnected on error
			if (sessionActive) {
				// Reload messages to pick up any events missed during the disconnect gap
				reloadMessages();
				// Sync streaming state in case agent_end was missed during disconnect
				syncStreamingState();
				setTimeout(() => connectSSE(sessionId), sseRetryDelay);
				sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_MAX_RETRY_DELAY);
			}
		};
	}

	function handleFireAndForget(event: any) {
		switch (event.method) {
			case 'notify':
				addToast(event.message || '', event.notifyType ?? 'info');
				break;
			case 'setStatus':
				if (event.statusText) {
					statusEntries = { ...statusEntries, [event.statusKey]: event.statusText };
				} else {
					const { [event.statusKey]: _, ...rest } = statusEntries;
					statusEntries = rest;
				}
				break;
			case 'setWidget':
				if (event.widgetLines) {
					widgetEntries = { ...widgetEntries, [event.widgetKey]: event.widgetLines };
				} else {
					const { [event.widgetKey]: _, ...rest } = widgetEntries;
					widgetEntries = rest;
				}
				break;
			case 'setTitle':
				document.title = event.title ?? 'Pi Dashboard';
				break;
		}
	}

	function addToast(message: string, severity: string) {
		const id = crypto.randomUUID();
		toasts = [...toasts, { id, message, severity }];
		setTimeout(() => {
			toasts = toasts.filter((t) => t.id !== id);
		}, 4000);
	}

	// Sync streaming state from server (used after SSE reconnect or missed events)
	async function syncStreamingState() {
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/state`);
			if (!res.ok) return;
			const state = await res.json();
			if (!state.active) {
				sessionActiveOverride = false;
				streaming = false;
			} else if (!state.isStreaming) {
				streaming = false;
				currentAssistantText = '';
				currentThinkingText = '';
				reloadMessages();
			}
		} catch { /* ignore */ }
	}

	// Connect SSE when session becomes active
	$effect(() => {
		if (sessionActive) {
			connectSSE(data.sessionId);
		}
		return () => {
			eventSource?.close();
			eventSource = null;
		};
	});

	// Fallback: poll session state to catch missed agent_end events
	// Uses exponential backoff: 1.5s, 3s, 6s, ... up to 30s
	$effect(() => {
		if (!streaming) return;
		let delay = 1500;
		let timer: ReturnType<typeof setTimeout>;
		let cancelled = false;

		async function poll() {
			if (cancelled) return;
			try {
				const res = await fetch(`/api/sessions/${data.sessionId}/state`);
				if (!res.ok) return;
				const state = await res.json();
				if (!state.active || !state.isStreaming) {
					streaming = false;
					waitingForAgent = false;
					pendingUserMessage = null;
					currentAssistantText = '';
					currentThinkingText = '';
					reloadMessages();
					return;
				}
			} catch { /* ignore */ }
			if (!cancelled) {
				delay = Math.min(delay * 2, 30_000);
				timer = setTimeout(poll, delay);
			}
		}

		timer = setTimeout(poll, delay);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	// Session control
	async function handleResume() {
		resuming = true;
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/resume`, { method: 'POST' });
			if (res.ok) {
				sessionActiveOverride = true;
			}
		} finally {
			resuming = false;
		}
	}

	async function handleStop() {
		await fetch(`/api/sessions/${data.sessionId}/stop`, { method: 'POST' });
		sessionActiveOverride = false;
	}

	async function handleAbort() {
		await fetch(`/api/sessions/${data.sessionId}/abort`, { method: 'POST' });
	}

	let restarting = $state(false);

	async function handleRestart() {
		restarting = true;
		try {
			await fetch(`/api/sessions/${data.sessionId}/stop`, { method: 'POST' });
			sessionActiveOverride = false;

			// Poll until the session is fully stopped before resuming
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 300));
				try {
					const res = await fetch(`/api/sessions/${data.sessionId}/state`);
					if (!res.ok) break;
					const state = await res.json();
					if (!state.active) break;
				} catch {
					break;
				}
			}

			const res = await fetch(`/api/sessions/${data.sessionId}/resume`, { method: 'POST' });
			if (res.ok) {
				sessionActiveOverride = true;
			}
		} finally {
			restarting = false;
		}
	}

	// Branch navigation
	function switchBranch(childId: string) {
		const leafId = findLeafFrom(tree, childId);
		currentLeaf = leafId;
		currentMessages = getPathToNode(tree, leafId);
	}

	// Event display helpers
	function eventIcon(eventType: string): string {
		switch (eventType) {
			case 'session_created': return '🟢';
			case 'session_resumed': return '⏯️';
			case 'session_stopped': return '🛑';
			case 'session_ended': return '🔴';
			case 'agent_start': return '▶️';
			case 'agent_end': return '⏹️';
			case 'compaction_start': return '🗜️';
			case 'compaction_end': return '✅';
			default: return '•';
		}
	}

	function eventLabel(eventType: string): string {
		switch (eventType) {
			case 'session_created': return 'Session created';
			case 'session_resumed': return 'Session resumed';
			case 'session_stopped': return 'Session stopped';
			case 'session_ended': return 'Session ended';
			case 'agent_start': return 'Agent started';
			case 'agent_end': return 'Agent finished';
			case 'compaction_start': return 'Compaction started';
			case 'compaction_end': return 'Compaction finished';
			default: return eventType;
		}
	}

	// Handle message sent callback (Issue 1)
	function handleMessageSent(text: string) {
		pendingUserMessage = text;
		waitingForAgent = true;
		scrollToBottom(true);
	}

	// Check for new session URL param (Issue 2)
	$effect(() => {
		if (typeof window !== 'undefined') {
			const params = new URLSearchParams(window.location.search);
			if (params.get('new') === '1') {
				addToast('Session created!', 'success');
				// Clear the URL param
				const url = new URL(window.location.href);
				url.searchParams.delete('new');
				window.history.replaceState({}, '', url);
			}
		}
	});

	const branchPoints = $derived(getBranchPoints(tree));
	const widgetList = $derived(Object.entries(widgetEntries));
</script>

<div class="flex h-full flex-col" bind:this={pageContainer}>
	<!-- Header -->
	<div class="navbar bg-base-200 shrink-0 z-10 border-b border-base-300">
		<div class="navbar-start">
			<a href="/" class="btn btn-ghost btn-sm">←</a>
		</div>
		<div class="navbar-center flex flex-col items-center">
			<span class="text-sm font-semibold truncate max-w-[200px] flex items-center gap-1.5">
				{#if restarting}
					<span class="loading loading-spinner loading-xs flex-shrink-0"></span>
				{:else if sessionActive}
					{#if streaming}
						<span class="relative flex h-2.5 w-2.5 flex-shrink-0">
							<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75"></span>
							<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning"></span>
						</span>
					{:else if !sseConnected}
						<span class="relative flex h-2.5 w-2.5 flex-shrink-0">
							<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75"></span>
							<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning"></span>
						</span>
					{:else}
						<span class="h-2.5 w-2.5 rounded-full bg-success flex-shrink-0"></span>
					{/if}
				{:else}
					<span class="h-2.5 w-2.5 rounded-full bg-base-content/20 flex-shrink-0"></span>
				{/if}
				{data.meta.name || data.meta.firstMessage}
			</span>
			<span class="text-xs text-base-content/50 truncate max-w-[200px]">
				{data.meta.cwd}
			</span>
		</div>
		<div class="navbar-end gap-1">
			{#if restarting}
				<span class="text-xs text-base-content/50">Restarting…</span>
			{:else if sessionActive}
				<!-- Desktop: inline buttons -->
				<button class="btn btn-ghost btn-xs hidden md:inline-flex" onclick={() => showEvents = !showEvents}>
					Activity
				</button>
				<button class="btn btn-ghost btn-xs text-error hidden md:inline-flex" onclick={handleAbort}>Abort</button>
				<button class="btn btn-ghost btn-xs hidden md:inline-flex" onclick={handleRestart}>Restart</button>
				<button class="btn btn-ghost btn-xs hidden md:inline-flex" onclick={handleStop}>Stop</button>
				<!-- Mobile: dropdown menu -->
				<div class="dropdown dropdown-end md:hidden">
					<div tabindex="0" role="button" class="btn btn-ghost btn-xs">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
					</div>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul tabindex="0" class="dropdown-content menu bg-base-200 rounded-box z-50 w-40 p-2 shadow-lg border border-base-300">
						<li><button class="text-error" onclick={handleAbort}>Abort</button></li>
						<li><button onclick={handleRestart}>Restart</button></li>
						<li><button onclick={handleStop}>Stop</button></li>
					</ul>
				</div>
			{:else}
				<span class="text-xs text-base-content/40">
					{timeAgo(data.meta.lastModified)}
				</span>
			{/if}
		</div>
	</div>

	<!-- Main content area: chat + event sidebar -->
	<div class="flex-1 flex flex-row overflow-hidden">
		<!-- Chat messages -->
		<div class="flex-1 overflow-y-auto overscroll-contain px-4 py-4" style="-webkit-overflow-scrolling: touch;" bind:this={chatContainer} onscroll={handleScroll}>
			{#if loadingMessages}
				<div class="flex items-center justify-center py-12">
					<span class="loading loading-spinner loading-md"></span>
					<span class="ml-2 text-base-content/50">Loading messages…</span>
				</div>
			{:else}
				{#if hasMore}
					<div class="text-center py-3">
						{#if loadingFull}
							<span class="loading loading-spinner loading-xs"></span>
							<span class="text-xs text-base-content/40 ml-1">Loading earlier messages…</span>
						{:else}
							<button class="btn btn-ghost btn-xs text-base-content/40" onclick={loadFullHistory}>Load earlier messages</button>
						{/if}
					</div>
				{/if}
				{#each currentMessages as entry (entry.id)}
					{#if branchPoints.has(entry.id)}
						<BranchIndicator branchPoint={branchPoints.get(entry.id)!} onselect={switchBranch} />
					{/if}
					<ChatBubble {entry} />
				{/each}

				<!-- Optimistic pending user message (Issue 1) -->
				{#if pendingUserMessage}
					<div class="chat chat-end mb-2">
						<div class="chat-bubble chat-bubble-primary max-w-[85vw] md:max-w-xl opacity-70 animate-pulse">
							<div class="whitespace-pre-wrap break-words text-sm">
								{pendingUserMessage}
							</div>
						</div>
					</div>
				{/if}

				<!-- Waiting for agent indicator (Issue 1) -->
				{#if waitingForAgent && !streaming}
					<div class="chat chat-start mb-2">
						<div class="chat-bubble max-w-[85vw] md:max-w-xl opacity-50">
							<span class="loading loading-dots loading-xs"></span>
							<span class="text-xs ml-1">sending to agent…</span>
						</div>
					</div>
				{/if}

				<!-- Streaming assistant text -->
				{#if streaming}
					<div class="chat chat-start mb-2">
						<div class="chat-bubble max-w-[85vw] md:max-w-xl">
							{#if currentThinkingText}
								<details class="mb-2 rounded bg-base-300/30 -mx-1" open>
									<summary class="cursor-pointer text-xs py-1 px-2 opacity-70">Thinking…</summary>
									<div class="text-xs font-mono whitespace-pre-wrap opacity-70 px-2 pb-2 max-h-48 overflow-y-auto">
										{currentThinkingText}
									</div>
								</details>
							{/if}
							<div class="whitespace-pre-wrap break-words text-sm">
								{currentAssistantText}
							</div>
							<span class="loading loading-dots loading-xs ml-1"></span>
						</div>
					</div>
				{/if}

				{#if compacting}
					<div class="text-center py-4">
						<span class="loading loading-spinner loading-sm"></span>
						<span class="text-sm text-base-content/50 ml-2">Compacting context…</span>
					</div>
				{/if}

				{#if retryInfo}
					<div class="alert alert-warning text-sm my-2">
						Retrying (attempt {retryInfo.attempt}/{retryInfo.maxAttempts})…
					</div>
				{/if}

				{#if currentMessages.length === 0 && !streaming && !pendingUserMessage}
					<div class="py-12 text-center text-base-content/50">
						{#if sessionActive}
							<p class="text-lg mb-2">Session ready</p>
							<p class="text-sm flex items-center justify-center gap-2">
								<span class="animate-bounce">↓</span>
								Type a message to get started
							</p>
						{:else}
							<p>Empty session</p>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Event log sidebar (desktop only) -->
		{#if showEvents}
			<div class="hidden md:flex flex-col w-64 border-l border-base-300 bg-base-200/50 overflow-hidden">
				<div class="p-3 text-sm font-semibold border-b border-base-300 flex items-center justify-between">
					<span>Activity Log</span>
					<button class="btn btn-ghost btn-xs" onclick={() => showEvents = false}>✕</button>
				</div>
				<div class="flex-1 overflow-y-auto p-2 space-y-1">
					{#if sessionEvents.length === 0}
						<div class="text-xs text-base-content/40 p-2">No events yet</div>
					{:else}
						{#each sessionEvents as event (event.id)}
							<div class="text-xs flex items-start gap-2 py-1.5 px-2 rounded hover:bg-base-300/50">
								<span class="text-base">{eventIcon(event.event_type)}</span>
								<div class="flex-1 min-w-0">
									<div class="font-medium">{eventLabel(event.event_type)}</div>
									<div class="text-base-content/40">{timeAgo(event.timestamp)}</div>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Scroll to bottom button -->
	{#if userScrolledUp}
		<div class="flex justify-center -mt-10 relative z-10">
			<button class="btn btn-circle btn-sm btn-ghost bg-base-300/80 shadow" onclick={() => scrollToBottom(true)}>
				↓
			</button>
		</div>
	{/if}

	<!-- Widget panels -->
	{#if widgetList.length > 0}
		{#each widgetList as [, lines]}
			<div class="bg-base-200 border-t border-base-300 px-4 py-2 text-sm font-mono shrink-0">
				{#each lines as line}
					<div>{line}</div>
				{/each}
			</div>
		{/each}
	{/if}

	<!-- Active session tabs -->
	<SessionTabs currentSessionId={data.sessionId} />

	<!-- Bottom bar — always visible -->
	<div class="shrink-0">
		{#if restarting}
			<div class="border-t border-base-300 bg-base-200 p-4 text-center">
				<span class="loading loading-spinner loading-sm"></span>
				<span class="text-sm text-base-content/50 ml-2">Restarting session…</span>
			</div>
		{:else if sessionActive}
			<MessageInput sessionId={data.sessionId} onsent={handleMessageSent} />
		{:else}
			<div class="border-t border-base-300 bg-base-200 p-4 text-center">
				<button class="btn btn-primary btn-sm" onclick={handleResume} disabled={resuming}>
					{#if resuming}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Resume Session
					{/if}
				</button>
				<div class="mt-2 flex items-center justify-center gap-2 text-xs text-base-content/50">
					<span>{data.meta.messageCount} messages</span>
					{#if data.meta.model}
						<span class="badge badge-xs badge-ghost">{data.meta.model}</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Extension UI Modal -->
	<ExtensionUIModal
		request={extensionUIRequest}
		sessionId={data.sessionId}
		onclose={() => (extensionUIRequest = null)}
	/>

	<!-- Toast stack -->
	{#if toasts.length > 0}
		<div class="toast toast-end z-50">
			{#each toasts as toast (toast.id)}
				<div class="alert" class:alert-error={toast.severity === 'error'} class:alert-warning={toast.severity === 'warning'} class:alert-info={toast.severity !== 'error' && toast.severity !== 'warning'}>
					<span>{toast.message}</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
