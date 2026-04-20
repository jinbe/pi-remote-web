<script lang="ts">
	import ChatBubble from '$lib/components/ChatBubble.svelte';
	import BranchIndicator from '$lib/components/BranchIndicator.svelte';
	import MessageInput from '$lib/components/MessageInput.svelte';
	import ExtensionUIModal from '$lib/components/ExtensionUIModal.svelte';
	import DiffModal from '$lib/components/DiffModal.svelte';
	import SessionTabs from '$lib/components/SessionTabs.svelte';
	import RepoSidebar from '$lib/components/RepoSidebar.svelte';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import StatusDot from '$lib/components/StatusDot.svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { toolSummary } from '$lib/tool-display';
	import { timeAgo, shortenHome, uniqueId } from '$lib/utils';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import { getPathToNode, isAncestorOf, findLeafFrom, getBranchPoints } from '$lib/session-tree';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
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
	let currentToolStatus = $state<{ name: string; summary: string } | null>(null);
	let compacting = $state(false);
	let retryInfo = $state<{ attempt: number; maxAttempts: number; delayMs: number } | null>(null);

	// Optimistic message state (Issue 1)
	let pendingUserMessage = $state<string | null>(null);
	let waitingForAgent = $state(false);

	// SSE connection state (Issue 3)
	let sseConnected = $state(false);

	// Session events
	let sessionEvents = $state<SessionEvent[]>([]);

	// Extension UI
	let extensionUIRequest = $state<ExtensionUIRequest | null>(null);

	// Right-side panel drawer (Changes + Activity tabs)
	let panelTab = $state<'changes' | 'activity' | null>(null);
	const showDrawer = $derived(panelTab !== null);
	function openPanel(tab: 'changes' | 'activity') {
		panelTab = tab;
	}
	function closePanel() {
		panelTab = null;
	}

	// Left repo sidebar — persistent on desktop, drawer on mobile
	let sidebarMobileOpen = $state(false);

	// New-session modal (triggered from sidebar). Optional cwd override —
	// the sidebar passes the project the user clicked "new in".
	let showNewSession = $state(false);
	let newSessionCwd = $state('');
	function onSidebarNewSession(cwd?: string) {
		newSessionCwd = cwd ?? data.meta.cwd;
		showNewSession = true;
	}

	// Toasts
	let toasts = $state<{ id: string; message: string; severity: string }[]>([]);

	// Status / Widget
	let statusEntries = $state<Record<string, string>>({});
	let widgetEntries = $state<Record<string, string[]>>({});

	// Scroll
	let chatContainer: HTMLElement | undefined = $state();
	let pageContainer: HTMLElement | undefined = $state();
	let userScrolledUp = $state(false);

	// Edge swipe to go back
	let edgeSwipeStartX = $state(0);
	let edgeSwipeStartY = $state(0);
	let edgeSwipeOffset = $state(0);
	let edgeSwiping = $state(false);
	let edgeSwipeLocked = $state(false);
	const EDGE_ZONE = 30; // px from left edge
	const EDGE_SWIPE_THRESHOLD = 100;

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
		if (!data.sessionId) return;
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
		if (!data.sessionId) return;
		loadingFull = true;
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/messages`);
			if (res.ok) {
				const result = await res.json();
				// Don't replace existing messages with empty results
				if (result.messages.length > 0 || currentMessages.length === 0) {
					tree = result.tree;
					currentLeaf = result.tree.currentLeaf;
					const wasAtBottom = isNearBottom();
					currentMessages = result.messages;
					hasMore = false;
					if (wasAtBottom) scrollToBottom(true);
				}
			}
		} catch (e) {
			console.error('Failed to load full history:', e);
		} finally {
			loadingFull = false;
		}
	}

	// Load session events
	async function loadEvents() {
		if (!data.sessionId) return;
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
		if (!data.sessionId) return;
		try {
			const res = await fetch(`/api/sessions/${data.sessionId}/messages`);
			if (res.ok) {
				const result = await res.json();
				// Don't replace existing messages with empty results
				// (happens for Claude Code sessions where the JSONL file
				// doesn't exist — conversation lives in SSE stream only)
				if (result.messages.length > 0 || currentMessages.length === 0) {
					tree = result.tree;
					currentLeaf = result.tree.currentLeaf;
					const wasAtBottom = isNearBottom();
					currentMessages = result.messages;
					if (wasAtBottom) scrollToBottom(true);
				}
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
		if (!data.sessionId) return;
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
			// The root layout applies padding-top: env(safe-area-inset-top),
			// so the available height inside the layout is less than vv.height.
			// Read the parent's padding to account for it.
			const parent = pageContainer.parentElement;
			const safeTop = parent ? parseInt(getComputedStyle(parent).paddingTop || '0', 10) : 0;
			pageContainer.style.height = `${vv.height - safeTop}px`;
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
					currentToolStatus = null;
					// Capture text BEFORE clearing — we may need to inline it
					// if the JSONL reload is slow (Claude flushes async, so
					// reload can return without the final message and the
					// chat would briefly go blank otherwise).
					{
						const finalText = event._lastAssistantText || currentAssistantText;
						const finalThinking = currentThinkingText;
						const finalModel = event.messages?.find((m: any) => m.role === 'assistant')?.model
							|| currentMessages.findLast?.((e: any) => e.message?.role === 'assistant')?.message?.model;
						currentAssistantText = '';
						currentThinkingText = '';
						// Surface API errors as a toast for immediate visibility
						if (event.messages?.length) {
							for (const msg of event.messages) {
								if (msg.stopReason === 'error' && msg.errorMessage) {
									const errorText = msg.errorMessage.length > 200
										? msg.errorMessage.slice(0, 200) + '…'
										: msg.errorMessage;
									addToast(errorText, 'error');
								}
							}
						}
						(async () => {
							await reloadMessages();
							// Empty session — full inline of agent_end's messages (existing behaviour)
							if (event.messages?.length && currentMessages.length === 0) {
								currentMessages = event.messages.map((m: any, i: number) => ({
									type: 'message',
									id: `inline-${i}`,
									parentId: i > 0 ? `inline-${i - 1}` : null,
									message: m
								}));
								scrollToBottom(true);
								return;
							}
							// Non-empty session: confirm the JSONL reload picked up the final
							// assistant text. If not (Claude flush lag), inline a synthetic
							// trailing message so it doesn't disappear.
							if (!finalText) return;
							const lastAssistant = [...currentMessages].reverse().find(
								(e: any) => e.message?.role === 'assistant'
							);
							const lastTextBlock = lastAssistant?.message?.content?.find?.(
								(c: any) => c.type === 'text'
							);
							const lastText: string = lastTextBlock?.text ?? '';
							// Match on the tail (last 80 chars) to tolerate trim/whitespace differences
							const tail = finalText.slice(-80);
							if (tail && !lastText.includes(tail)) {
								const lastId = currentMessages[currentMessages.length - 1]?.id ?? null;
								const synthetic: any = {
									type: 'message',
									id: `inline-final-${Date.now()}`,
									parentId: lastId,
									timestamp: new Date().toISOString(),
									message: {
										role: 'assistant',
										content: [
											...(finalThinking ? [{ type: 'thinking', thinking: finalThinking }] : []),
											{ type: 'text', text: finalText },
										],
										...(finalModel ? { model: finalModel } : {}),
									}
								};
								currentMessages = [...currentMessages, synthetic];
								scrollToBottom(true);
							}
						})();
					}
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
				case 'tool_execution_start': {
					const summary = toolSummary({ name: event.toolName, arguments: event.args ?? {} });
					currentToolStatus = { name: event.toolName, summary };
					scrollToBottom();
					break;
				}
				case 'tool_execution_update':
					scrollToBottom();
					break;
				case 'tool_execution_end':
					currentToolStatus = null;
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
		const id = uniqueId();
		toasts = [...toasts, { id, message, severity }];
		const duration = severity === 'error' ? 8000 : 4000;
		setTimeout(() => {
			toasts = toasts.filter((t) => t.id !== id);
		}, duration);
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

	// Fallback: poll session state to catch missed agent_end events.
	// Keep this as a fixed 1.5s interval — exponential backoff sounds nice but
	// ends up waiting 30s to clear the UI when an agent_end event is missed.
	$effect(() => {
		if (!streaming) return;
		const interval = setInterval(async () => {
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
				}
			} catch { /* ignore */ }
		}, 1500);
		return () => clearInterval(interval);
	});

	// Session control
	async function handleResume() {
		hapticMedium();
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
		hapticHeavy();
		await fetch(`/api/sessions/${data.sessionId}/stop`, { method: 'POST' });
		sessionActiveOverride = false;
	}

	async function handleAbort() {
		hapticHeavy();
		await fetch(`/api/sessions/${data.sessionId}/abort`, { method: 'POST' });
	}

	let restarting = $state(false);

	async function handleRestart() {
		hapticMedium();
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
		hapticLight();
		const leafId = findLeafFrom(tree, childId);
		currentLeaf = leafId;
		currentMessages = getPathToNode(tree, leafId);
	}

	// Event display helpers
	function eventIconName(eventType: string): IconName | '' {
		switch (eventType) {
			case 'session_created': return 'circle-green';
			case 'session_resumed': return 'play-pause';
			case 'session_stopped': return 'stop-circle';
			case 'session_ended': return 'circle-red';
			case 'agent_start': return 'play';
			case 'agent_end': return 'stop';
			case 'compaction_start': return 'compress';
			case 'compaction_end': return 'check-circle';
			default: return '';
		}
	}

	function eventIconClass(eventType: string): string {
		switch (eventType) {
			case 'session_created': return 'w-4 h-4 text-success';
			case 'session_ended': return 'w-4 h-4 text-error';
			default: return 'w-4 h-4';
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
		hapticMedium();
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

	// Edge swipe navigation
	function onEdgeSwipeStart(e: TouchEvent) {
		const touch = e.touches[0];
		if (touch.clientX > EDGE_ZONE) return; // Only activate from left edge
		edgeSwipeStartX = touch.clientX;
		edgeSwipeStartY = touch.clientY;
		edgeSwiping = true;
		edgeSwipeLocked = false;
		edgeSwipeOffset = 0;
	}

	function onEdgeSwipeMove(e: TouchEvent) {
		if (!edgeSwiping) return;
		const touch = e.touches[0];
		const dx = touch.clientX - edgeSwipeStartX;
		const dy = touch.clientY - edgeSwipeStartY;

		if (!edgeSwipeLocked && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
			if (Math.abs(dy) > Math.abs(dx)) {
				// Vertical — cancel edge swipe
				edgeSwiping = false;
				edgeSwipeOffset = 0;
				return;
			}
			edgeSwipeLocked = true;
		}

		if (edgeSwipeLocked && dx > 0) {
			e.preventDefault();
			edgeSwipeOffset = Math.min(dx * 0.6, 200); // Dampen
		}
	}

	function onEdgeSwipeEnd() {
		if (!edgeSwiping) return;
		if (edgeSwipeOffset >= EDGE_SWIPE_THRESHOLD) {
			hapticLight();
			edgeSwipeOffset = window.innerWidth; // Animate off screen
			setTimeout(() => goto('/'), 200);
		} else {
			edgeSwipeOffset = 0;
		}
		edgeSwiping = false;
		edgeSwipeLocked = false;
	}
</script>

<!-- Edge swipe back indicator -->
{#if edgeSwipeOffset > 0}
	<div class="fixed inset-y-0 left-0 w-12 z-50 flex items-center justify-center pointer-events-none">
		<span
			class="transition-opacity duration-150 inline-flex"
			style="opacity: {Math.min(edgeSwipeOffset / EDGE_SWIPE_THRESHOLD, 1)};"
		>
			<Icon name="arrow-left" class="w-6 h-6" />
		</span>
	</div>
{/if}

<div class="flex h-full">
	<RepoSidebar
		projects={data.projects ?? []}
		currentSessionId={data.sessionId}
		activeCount={data.activeCount ?? 0}
		activeJobCount={data.activeJobCount ?? 0}
		bind:mobileOpen={sidebarMobileOpen}
		onnewsession={onSidebarNewSession}
	/>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex h-full flex-col flex-1 min-w-0"
		class:swipe-transition={!edgeSwiping}
		style="transform: translateX({edgeSwipeOffset}px);"
		bind:this={pageContainer}
		ontouchstart={onEdgeSwipeStart}
		ontouchmove={onEdgeSwipeMove}
		ontouchend={onEdgeSwipeEnd}
	>
		<!-- Header -->
		<div class="shrink-0 z-10 border-b border-base-300 flex items-center gap-3 px-3 sm:px-5 py-3">
			<button class="md:hidden btn btn-ghost btn-sm btn-square" aria-label="Open sidebar" onclick={() => { hapticLight(); sidebarMobileOpen = true; }}>
				<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" /></svg>
			</button>
			<a href="/" class="hidden md:inline-flex btn btn-ghost btn-sm btn-square" aria-label="Back to dashboard"><Icon name="arrow-left" class="w-5 h-5" /></a>
		<div class="flex-1 min-w-0 flex flex-col">
			<span class="text-[10.5px] font-medium uppercase tracking-[0.12em] text-base-content-faint truncate">
				{shortenHome(data.meta.cwd)}
			</span>
			<span class="text-[15px] font-semibold tracking-[-0.02em] truncate flex items-center gap-2 mt-0.5">
				{#if restarting}
					<span class="loading loading-spinner loading-xs flex-shrink-0"></span>
				{:else}
					<StatusDot status={sessionActive ? (streaming || !sseConnected ? 'streaming' : 'idle') : 'inactive'} size="md" />
				{/if}
				<span class="truncate">{data.meta.name || data.meta.firstMessage}</span>
			</span>
		</div>
		<div class="flex items-center gap-2">
			{#if data.gitBranch}
				<button class="hidden sm:inline-flex items-center gap-1 font-mono text-[11px] text-base-content-subtle border border-base-300 px-2 py-1 hover:bg-base-200 transition-colors" onclick={() => { hapticLight(); openPanel('changes'); }} title="View changes">
					⎇ {data.gitBranch}
				</button>
			{/if}
			<span class="hidden sm:block w-px h-4 bg-base-300"></span>
			{#if restarting}
				<span class="text-xs text-base-content/50">Restarting…</span>
			{:else if sessionActive}
				{#if data.gitBranch}
					<button class="btn btn-ghost btn-xs hidden md:inline-flex" onclick={() => { hapticLight(); openPanel('changes'); }} aria-label="View changes">
						Changes
					</button>
				{/if}
				<button class="btn btn-ghost btn-xs hidden md:inline-flex" onclick={() => { hapticLight(); openPanel('activity'); }} aria-label="Open activity log">
					Activity
				</button>
				<!-- Kebab — Restart + mobile-only Changes/Activity. Stop / Refresh / Theme live in the sidebar footer. -->
				<div class="dropdown dropdown-end">
					<div tabindex="0" role="button" class="btn btn-ghost btn-sm btn-square" aria-label="Session actions">
						<Icon name="more-vertical" class="w-4 h-4" />
					</div>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul tabindex="0" class="dropdown-content menu bg-base-200 z-50 w-44 p-2 border border-base-300">
						{#if data.gitBranch}
							<li class="md:hidden"><button onclick={() => openPanel('changes')}>Changes</button></li>
						{/if}
						<li class="md:hidden"><button onclick={() => openPanel('activity')}>Activity</button></li>
						<li><button onclick={handleRestart}><Icon name="refresh" class="w-4 h-4" /> Restart</button></li>
						<li><button class="text-accent" onclick={handleStop}><Icon name="stop" class="w-4 h-4" /> Stop session</button></li>
					</ul>
				</div>
			{:else}
				<span class="text-xs text-base-content-faint">
					{timeAgo(data.meta.lastModified)}
				</span>
			{/if}
		</div>
	</div>

	<!-- Main content area: chat + event sidebar -->
	<div class="flex-1 flex flex-row overflow-hidden">
		<!-- Chat messages -->
		<div class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4" style="-webkit-overflow-scrolling: touch;" bind:this={chatContainer} onscroll={handleScroll}>
			{#if loadingMessages}
				<div class="space-y-4 py-4 animate-pulse">
					<!-- Skeleton: user message (right) -->
					<div class="chat chat-end">
						<div class="chat-bubble bg-primary/20 border-0 max-w-[65vw] md:max-w-md">
							<div class="h-3 bg-primary/15 rounded w-48 mb-2"></div>
							<div class="h-3 bg-primary/15 rounded w-32"></div>
						</div>
					</div>
					<!-- Skeleton: assistant message (left) -->
					<div class="chat chat-start">
						<div class="chat-bubble bg-base-300/50 border-0 max-w-[75vw] md:max-w-lg">
							<div class="h-3 bg-base-content/10 rounded w-56 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-72 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-40"></div>
						</div>
					</div>
					<!-- Skeleton: tool result (left) -->
					<div class="chat chat-start">
						<div class="chat-bubble bg-secondary/15 border-0 max-w-[60vw] md:max-w-sm">
							<div class="h-3 bg-base-content/10 rounded w-36 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-24"></div>
						</div>
					</div>
					<!-- Skeleton: assistant message (left) -->
					<div class="chat chat-start">
						<div class="chat-bubble bg-base-300/50 border-0 max-w-[75vw] md:max-w-lg">
							<div class="h-3 bg-base-content/10 rounded w-64 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-48 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-56 mb-2"></div>
							<div class="h-3 bg-base-content/10 rounded w-28"></div>
						</div>
					</div>
				</div>
			{:else}
				{#if hasMore}
					<div class="text-center py-3">
						{#if loadingFull}
							<span class="loading loading-spinner loading-xs"></span>
							<span class="text-xs text-base-content-faint ml-1">Loading earlier messages…</span>
						{:else}
							<button class="btn btn-ghost btn-xs text-base-content-faint" onclick={loadFullHistory}>Load earlier messages</button>
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
						<div class="chat-bubble chat-bubble-primary max-w-[90vw] md:max-w-xl overflow-hidden opacity-70 animate-pulse motion-reduce:animate-none">
							<div class="whitespace-pre-wrap break-words text-sm">
								{pendingUserMessage}
							</div>
						</div>
					</div>
				{/if}

				<!-- Waiting for agent indicator (Issue 1) -->
				{#if waitingForAgent && !streaming}
					<div class="chat chat-start mb-2">
						<div class="chat-bubble max-w-[90vw] md:max-w-xl overflow-hidden opacity-50">
							<span class="loading loading-dots loading-xs"></span>
							<span class="text-xs ml-1">sending to agent…</span>
						</div>
					</div>
				{/if}

				<!-- Streaming assistant text -->
				{#if streaming}
					<div class="chat chat-start mb-2">
						<div class="chat-bubble max-w-[90vw] md:max-w-xl overflow-hidden">
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
							<div class="flex items-center gap-2 mt-1 min-w-0">
								<span class="loading loading-dots loading-xs flex-shrink-0"></span>
								{#if currentToolStatus}
									<span class="text-[11px] text-base-content-subtle truncate min-w-0" title={currentToolStatus.summary}>
										<span class="font-medium">{currentToolStatus.name}</span>{#if currentToolStatus.summary}<span class="opacity-70">: {currentToolStatus.summary}</span>{/if}
									</span>
								{/if}
								<button
									class="btn btn-ghost btn-circle btn-xs text-error opacity-70 ml-auto flex-shrink-0"
									aria-label="Abort"
									onclick={handleAbort}
								>
									<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
								</button>
							</div>
						</div>
					</div>
				{/if}

				{#if compacting}
					<div class="text-center py-4">
						<span class="loading loading-spinner loading-sm"></span>
						<span class="text-sm text-base-content-subtle ml-2">Compacting context…</span>
					</div>
				{/if}

				{#if retryInfo}
					<div class="alert alert-warning text-sm my-2">
						Retrying (attempt {retryInfo.attempt}/{retryInfo.maxAttempts})…
					</div>
				{/if}

				{#if currentMessages.length === 0 && !streaming && !pendingUserMessage}
					<div class="py-12 text-center text-base-content-subtle">
						{#if sessionActive}
							<p class="text-lg mb-2">Session ready</p>
							<p class="text-sm flex items-center justify-center gap-2">
								<span class="animate-bounce inline-flex"><Icon name="arrow-down" class="w-4 h-4" /></span>
								Type a message to get started
							</p>
						{:else}
							<p>Empty session</p>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Activity log moved into the right-side drawer (Activity tab) -->
	</div>

	<!-- Scroll to bottom button -->
	<div class="flex justify-center -mt-10 relative z-10 transition-all duration-300 ease-out {userScrolledUp ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}">
		<button class="btn btn-circle btn-sm btn-ghost bg-base-300/80 shadow" onclick={() => scrollToBottom(true)} aria-label="Scroll to bottom">
			<Icon name="arrow-down" class="w-4 h-4" />
		</button>
	</div>

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
			<div class="border-t border-base-300 bg-base-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center">
				<span class="loading loading-spinner loading-sm"></span>
				<span class="text-sm text-base-content-subtle ml-2">Restarting session…</span>
			</div>
		{:else if sessionActive}
			<MessageInput sessionId={data.sessionId} {streaming} onsent={handleMessageSent} />
		{:else}
			<div class="border-t border-base-300 bg-base-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center">
				<button class="btn btn-primary btn-sm" onclick={handleResume} disabled={resuming}>
					{#if resuming}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Resume Session
					{/if}
				</button>
				<div class="mt-2 flex items-center justify-center gap-2 text-xs text-base-content-subtle">
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

	<!-- Diff Viewer Modal -->
	<DiffModal
		open={showDrawer}
		sessionId={data.sessionId}
		tab={panelTab ?? 'changes'}
		events={sessionEvents}
		ontab={(t) => openPanel(t)}
		onclose={closePanel}
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
</div>

<NewSessionModal
	open={showNewSession}
	defaultCwd={newSessionCwd || data.meta.cwd}
	defaultHarness={((data.projects ?? []).flatMap((p) => p.sessions)[0]?.harness as 'pi' | 'claude-code') || 'pi'}
	onclose={() => (showNewSession = false)}
/>

<style>
	.swipe-transition {
		transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
	}
</style>
