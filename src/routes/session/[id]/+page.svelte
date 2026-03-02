<script lang="ts">
	import ChatBubble from '$lib/components/ChatBubble.svelte';
	import BranchIndicator from '$lib/components/BranchIndicator.svelte';
	import MessageInput from '$lib/components/MessageInput.svelte';
	import ExtensionUIModal from '$lib/components/ExtensionUIModal.svelte';
	import { timeAgo } from '$lib/utils';
	import type { AgentMessage, SessionTree, BranchPoint, ExtensionUIRequest } from '$lib/types';

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
			}
		} catch (e) {
			console.error('Failed to reload messages:', e);
		}
	}

	// Load on mount and when session changes
	$effect(() => {
		void data.sessionId; // track dependency
		loadTail();
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

	// SSE connection
	function connectSSE(sessionId: string) {
		if (eventSource) {
			eventSource.close();
		}

		eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

		eventSource.onmessage = (e) => {
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
					break;
				case 'agent_end':
					streaming = false;
					currentAssistantText = '';
					currentThinkingText = '';
					reloadMessages();
					break;
				case 'session_ended':
					streaming = false;
					sessionActiveOverride = false;
					eventSource?.close();
					eventSource = null;
					reloadMessages();
					break;
				case 'message_start':
					if (event.message?.role === 'assistant') {
						// Reload to pick up previously completed messages
						reloadMessages();
						currentAssistantText = '';
						currentThinkingText = '';
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
					break;
				case 'auto_compaction_end':
					compacting = false;
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
			if (sessionActive) {
				// Reload messages to pick up any events missed during the disconnect gap
				reloadMessages();
				setTimeout(() => connectSSE(sessionId), 2000);
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
	$effect(() => {
		if (!streaming) return;
		const interval = setInterval(async () => {
			try {
				const res = await fetch(`/api/sessions/${data.sessionId}/state`);
				if (!res.ok) return;
				const state = await res.json();
				if (!state.active || !state.isStreaming) {
					streaming = false;
					currentAssistantText = '';
					currentThinkingText = '';
					reloadMessages();
				}
			} catch { /* ignore */ }
		}, 5000);
		return () => clearInterval(interval);
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

	// Branch navigation
	function computeBranchPoints(t: SessionTree): Map<string, BranchPoint> {
		const map = new Map<string, BranchPoint>();
		for (const [parentId, childIds] of Object.entries(t.children)) {
			if (childIds.length <= 1) continue;
			const node = t.nodes[parentId];
			if (!node) continue;

			let message = '';
			if (node.type === 'message' && node.message?.content) {
				const tc = node.message.content.find((c: any) => c.type === 'text');
				message = tc?.text?.slice(0, 100) || '';
			}

			const branches = childIds.map((childId) => {
				const child = t.nodes[childId];
				let preview = '';
				if (child?.type === 'message' && child.message?.content) {
					const tc = child.message.content.find((c: any) => c.type === 'text');
					preview = tc?.text?.slice(0, 80) || '';
				}

				let count = 0;
				let cur: string | null = childId;
				while (cur && t.nodes[cur]) {
					count++;
					const kids: string[] | undefined = t.children[cur];
					cur = kids && kids.length > 0 ? kids[0] : null;
				}

				const isCurrentPath = isAncestor(childId, currentLeaf);
				return { childId, preview, messageCount: count, isCurrentPath };
			});

			map.set(parentId, { nodeId: parentId, message, branches });
		}
		return map;
	}

	function isAncestor(ancestorId: string, descendantId: string): boolean {
		let cur: string | null | undefined = descendantId;
		while (cur) {
			if (cur === ancestorId) return true;
			cur = tree.nodes[cur]?.parentId;
		}
		return false;
	}

	function getPathToNode(nodeId: string): AgentMessage[] {
		const path: AgentMessage[] = [];
		let cur: string | null | undefined = nodeId;
		while (cur && tree.nodes[cur]) {
			path.unshift(tree.nodes[cur]);
			cur = tree.nodes[cur].parentId;
		}
		return path;
	}

	function findLeaf(startId: string): string {
		let cur = startId;
		while (true) {
			const kids = tree.children[cur];
			if (!kids || kids.length === 0) return cur;
			cur = kids[0];
		}
	}

	function switchBranch(childId: string) {
		const leafId = findLeaf(childId);
		currentLeaf = leafId;
		currentMessages = getPathToNode(leafId);
	}

	const branchPoints = $derived(computeBranchPoints(tree));
	const statusList = $derived(Object.entries(statusEntries));
	const widgetList = $derived(Object.entries(widgetEntries));
</script>

<div class="flex h-full flex-col" bind:this={pageContainer}>
	<!-- Header -->
	<div class="navbar bg-base-200 shrink-0 z-10 border-b border-base-300">
		<div class="navbar-start">
			<a href="/" class="btn btn-ghost btn-sm">←</a>
		</div>
		<div class="navbar-center flex flex-col">
			<span class="text-sm font-semibold truncate max-w-[200px]">
				{data.meta.name || data.meta.firstMessage}
			</span>
			<span class="text-xs text-base-content/50 truncate max-w-[200px]">
				{data.meta.cwd}
			</span>
		</div>
		<div class="navbar-end gap-1">
			{#if statusList.length > 0}
				{#each statusList as [, text]}
					<span class="badge badge-xs badge-info max-w-[100px] md:max-w-[200px] truncate" title={text}>{text}</span>
				{/each}
			{/if}
			{#if sessionActive}
				{#if streaming}
					<span class="badge badge-warning badge-xs gap-1">
						<span class="loading loading-dots loading-xs"></span>
						working
					</span>
				{:else}
					<span class="badge badge-success badge-xs">live</span>
				{/if}
				<button class="btn btn-ghost btn-xs text-error" onclick={handleAbort}>Abort</button>
				<button class="btn btn-ghost btn-xs" onclick={handleStop}>Stop</button>
			{:else}
				<span class="text-xs text-base-content/40">
					{timeAgo(data.meta.lastModified)}
				</span>
			{/if}
		</div>
	</div>

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

			{#if currentMessages.length === 0 && !streaming}
				<div class="py-12 text-center text-base-content/50">
					<p>Empty session</p>
				</div>
			{/if}
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

	<!-- Bottom bar — always visible -->
	<div class="shrink-0">
		{#if sessionActive}
			<MessageInput sessionId={data.sessionId} />
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
