<!--
	PathInput — a text input that autocompletes file/folder paths by querying
	/api/path-autocomplete as the user types.

	Usage:
	  <PathInput id="my-id" bind:value={path} placeholder="/path/to/dir" />
-->
<script lang="ts">
	import { hapticLight } from '$lib/haptics';

	let {
		id = '',
		value = $bindable(''),
		placeholder = '/path/to/directory',
		class: className = '',
		disabled = false,
		onconfirm,
	}: {
		id?: string;
		value?: string;
		placeholder?: string;
		class?: string;
		disabled?: boolean;
		/** Called when the user presses Enter or selects a non-directory suggestion */
		onconfirm?: () => void;
	} = $props();

	let suggestions = $state<string[]>([]);
	let open = $state(false);
	let activeIndex = $state(-1);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const DEBOUNCE_MS = 120;

	async function fetchSuggestions(q: string) {
		if (!q) {
			suggestions = [];
			open = false;
			return;
		}
		try {
			const res = await fetch(`/api/path-autocomplete?q=${encodeURIComponent(q)}`);
			if (!res.ok) return;
			const data = await res.json();
			suggestions = data.suggestions ?? [];
			activeIndex = -1;
			open = suggestions.length > 0;
		} catch {
			suggestions = [];
			open = false;
		}
	}

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		value = target.value;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => fetchSuggestions(value), DEBOUNCE_MS);
	}

	function selectSuggestion(s: string) {
		hapticLight();
		value = s;
		suggestions = [];
		open = false;
		activeIndex = -1;
		// If the suggestion is a directory (trailing slash), keep focus so user
		// can continue typing. Otherwise fire onconfirm.
		if (!s.endsWith('/')) {
			onconfirm?.();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, -1);
		} else if (e.key === 'Enter' && activeIndex >= 0) {
			e.preventDefault();
			selectSuggestion(suggestions[activeIndex]);
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Tab' && suggestions.length > 0) {
			// Tab-complete to the first suggestion
			e.preventDefault();
			selectSuggestion(suggestions[activeIndex >= 0 ? activeIndex : 0]);
		}
	}

	function handleBlur() {
		// Delay so click on a suggestion fires first
		setTimeout(() => {
			open = false;
		}, 150);
	}

	/** Display the tail of the path for readability inside the dropdown */
	function displayLabel(s: string): string {
		const trimmed = s.endsWith('/') ? s.slice(0, -1) : s;
		const parts = trimmed.split('/');
		const name = parts.pop() ?? '';
		const parent = parts.slice(-2).join('/');
		return parent ? `…/${parent}/${name}` : name;
	}
</script>

<div class="relative w-full">
	<input
		{id}
		{placeholder}
		{disabled}
		type="text"
		class="input w-full {className}"
		autocomplete="off"
		spellcheck="false"
		value={value}
		oninput={handleInput}
		onkeydown={handleKeydown}
		onblur={handleBlur}
		onfocus={() => { if (suggestions.length > 0) open = true; }}
	/>

	{#if open && suggestions.length > 0}
		<ul
			class="absolute z-50 mt-1 w-full overflow-auto rounded-box border border-base-300 bg-base-200 shadow-lg"
			style="max-height: 14rem;"
			role="listbox"
		>
			{#each suggestions as s, i}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					role="option"
					aria-selected={i === activeIndex}
					class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors
						{i === activeIndex ? 'bg-primary/20 text-primary-content' : 'hover:bg-base-300'}"
					onmousedown={(e) => { e.preventDefault(); selectSuggestion(s); }}
				>
					<!-- Folder / file icon -->
					{#if s.endsWith('/')}
						<svg class="h-3.5 w-3.5 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
						</svg>
					{:else}
						<svg class="h-3.5 w-3.5 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
						</svg>
					{/if}
					<span class="truncate font-mono">{displayLabel(s)}</span>
					<span class="ml-auto truncate text-xs opacity-40">{s}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
