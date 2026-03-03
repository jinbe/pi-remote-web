<script lang="ts">
	interface SlashCommand {
		name: string;
		description?: string;
		source: 'extension' | 'prompt' | 'skill';
	}

	let {
		sessionId,
		disabled = false,
		streaming = false,
		onsent
	}: {
		sessionId: string;
		disabled?: boolean;
		streaming?: boolean;
		onsent?: (text: string) => void;
	} = $props();

	let message = $state('');
	let sending = $state(false);
	let showSendMenu = $state(false);

	// Autocomplete state
	let commands = $state<SlashCommand[]>([]);
	let commandsLoaded = $state(false);
	let showAutocomplete = $state(false);
	let selectedIndex = $state(0);
	let menuRef: HTMLUListElement | undefined = $state();

	const filtered = $derived.by(() => {
		if (!showAutocomplete) return [];
		const input = message.slice(1).toLowerCase(); // strip leading /
		return commands.filter((c) => c.name.toLowerCase().startsWith(input));
	});

	// Fetch commands lazily on first /
	async function ensureCommands() {
		if (commandsLoaded) return;
		try {
			const res = await fetch(`/api/sessions/${sessionId}/commands`);
			if (res.ok) {
				const data = await res.json();
				commands = Array.isArray(data.commands) ? data.commands : [];
			}
		} catch {
			/* ignore */
		}
		commandsLoaded = true;
	}

	function updateAutocomplete() {
		// Show autocomplete when input starts with / and has no spaces yet (typing command name)
		if (message.startsWith('/') && !message.includes(' ') && message.length >= 1) {
			showAutocomplete = true;
			selectedIndex = 0;
		} else {
			showAutocomplete = false;
		}
	}

	function acceptCompletion(cmd: SlashCommand) {
		message = '/' + cmd.name + ' ';
		showAutocomplete = false;
	}

	async function doSend(behavior?: 'steer') {
		if (!message.trim() || sending) return;
		sending = true;
		showSendMenu = false;

		const sentText = message.trim();

		try {
			const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: sentText,
					behavior: behavior || undefined
				})
			});

			if (res.ok) {
				onsent?.(sentText);
				message = '';
				showAutocomplete = false;
			}
		} finally {
			sending = false;
		}
	}

	function handleSend() {
		doSend();
	}

	function handleSteer() {
		doSend('steer');
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showAutocomplete && filtered.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selectedIndex = (selectedIndex + 1) % filtered.length;
				scrollSelectedIntoView();
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
				scrollSelectedIntoView();
				return;
			}
			if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
				e.preventDefault();
				acceptCompletion(filtered[selectedIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				showAutocomplete = false;
				return;
			}
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	async function handleInput() {
		if (message.startsWith('/')) {
			await ensureCommands();
		}
		updateAutocomplete();
	}

	function scrollSelectedIntoView() {
		requestAnimationFrame(() => {
			menuRef?.querySelector('.bg-base-300')?.scrollIntoView({ block: 'nearest' });
		});
	}

	// Quick commands
	const quickCommands = [
		{ label: 'Continue', message: 'continue' },
		{ label: 'Ship', message: 'ship' },
		{ label: 'Commit no push', message: 'commit no push' },
		{ label: 'Create PR', message: 'create pr' }
	];

	async function sendQuickCommand(text: string) {
		if (sending || disabled) return;
		sending = true;
		try {
			const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: text })
			});
			if (res.ok) {
				onsent?.(text);
			}
		} finally {
			sending = false;
		}
	}

	// Source badge color
	function sourceBadge(source: string) {
		switch (source) {
			case 'extension': return 'badge-primary';
			case 'skill': return 'badge-secondary';
			case 'prompt': return 'badge-accent';
			default: return 'badge-ghost';
		}
	}

	// Close send menu on outside click
	function handleWindowClick(e: MouseEvent) {
		if (showSendMenu) {
			const target = e.target as HTMLElement;
			if (!target.closest('.send-menu-container')) {
				showSendMenu = false;
			}
		}
	}
</script>

<svelte:window onclick={handleWindowClick} />

<div class="border-t border-base-300 bg-base-200 p-3 relative">
	<!-- Autocomplete dropdown -->
	{#if showAutocomplete && filtered.length > 0}
		<div class="absolute bottom-full left-3 right-3 mb-1 z-20">
			<ul
				class="menu menu-sm bg-base-100 rounded-box shadow-lg border border-base-300 max-h-52 overflow-y-auto flex-nowrap"
				bind:this={menuRef}
			>
				{#each filtered as cmd, i (cmd.name)}
					<li>
						<button
							class="flex items-center gap-2 {i === selectedIndex ? 'bg-base-300' : ''}"
							onmousedown={(e) => { e.preventDefault(); acceptCompletion(cmd); }}
							onmouseenter={() => (selectedIndex = i)}
						>
							<span class="font-mono text-sm">/{cmd.name}</span>
							<span class="badge badge-xs {sourceBadge(cmd.source)}">{cmd.source}</span>
							{#if cmd.description}
								<span class="text-xs text-base-content/50 truncate">{cmd.description}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Quick commands -->
	<div class="flex gap-1.5 mb-2 overflow-x-auto">
		{#each quickCommands as cmd (cmd.label)}
			<button
				class="btn btn-xs btn-outline btn-ghost rounded-full whitespace-nowrap"
				onclick={() => sendQuickCommand(cmd.message)}
				disabled={disabled || sending}
			>
				{cmd.label}
			</button>
		{/each}
	</div>

	<div class="flex gap-2">
		<textarea
			class="textarea flex-1 min-h-[3rem] max-h-40 resize-none"
			placeholder="Type a message... (/ for commands)"
			bind:value={message}
			onkeydown={handleKeydown}
			oninput={handleInput}
			{disabled}
			rows={2}
		></textarea>
		<!-- Send button with optional steer dropdown while streaming -->
		<div class="self-end send-menu-container relative">
			{#if streaming}
				<div class="join join-vertical">
					<button
						class="btn btn-primary btn-sm join-item"
						onclick={handleSend}
						disabled={disabled || !message.trim() || sending}
					>
						{#if sending}
							<span class="loading loading-spinner loading-xs"></span>
						{:else}
							⏎
						{/if}
					</button>
					<button
						class="btn btn-primary btn-sm btn-outline join-item px-1"
						aria-label="Send options"
						onclick={() => (showSendMenu = !showSendMenu)}
						disabled={disabled || !message.trim() || sending}
					>
						<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
							<path d="M6 9l6 6 6-6" />
						</svg>
					</button>
				</div>
				{#if showSendMenu}
					<div class="absolute bottom-full right-0 mb-1 z-30">
						<ul class="menu menu-sm bg-base-100 rounded-box shadow-lg border border-base-300 w-40">
							<li>
								<button onclick={handleSteer}>
									<span>⚡ Steer</span>
									<span class="text-[10px] opacity-50">interrupt</span>
								</button>
							</li>
						</ul>
					</div>
				{/if}
			{:else}
				<button
					class="btn btn-primary btn-sm"
					onclick={handleSend}
					disabled={disabled || !message.trim() || sending}
				>
					{#if sending}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						⏎
					{/if}
				</button>
			{/if}
		</div>
	</div>
</div>
