<script lang="ts">
	import { onMount } from 'svelte';
	import { hapticLight } from '$lib/haptics';

	interface Props {
		value: string;
		harness?: 'pi' | 'claude-code';
		placeholder?: string;
		id?: string;
		disabled?: boolean;
		onchange?: (model: string) => void;
	}

	let {
		value = $bindable(''),
		harness = 'pi',
		placeholder = 'e.g. anthropic/claude-sonnet-4',
		id = 'model-input',
		disabled = false,
		onchange,
	}: Props = $props();

	let models = $state<string[]>([]);
	let isOpen = $state(false);
	let isLoading = $state(true);
	let errorMsg = $state('');
	let inputEl: HTMLInputElement | undefined = $state();
	let listEl: HTMLUListElement | undefined = $state();
	let highlightedIndex = $state(-1);
	let userTyped = $state(false);

	// Fetch models when harness changes
	$effect(() => {
		const h = harness;
		isLoading = true;
		errorMsg = '';
		highlightedIndex = -1;

		fetchModels(h);
	});

	async function fetchModels(h: string) {
		try {
			const res = await fetch(`/api/models?harness=${h}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			models = data.models;
		} catch (err) {
			console.error('[ModelSelect] failed to fetch models:', err);
			errorMsg = 'Failed to load models';
		} finally {
			isLoading = false;
		}
	}

	// Filter models based on input
	const filteredModels = $derived.by(() => {
		if (!userTyped || !value.trim()) return models.slice(0, 20);
		const q = value.toLowerCase();
		return models.filter((m) => m.toLowerCase().includes(q)).slice(0, 20);
	});

	function openDropdown() {
		if (disabled || isLoading) return;
		isOpen = true;
		highlightedIndex = -1;
	}

	function closeDropdown() {
		isOpen = false;
		highlightedIndex = -1;
	}

	function selectModel(model: string) {
		value = model;
		userTyped = false;
		closeDropdown();
		onchange?.(model);
		inputEl?.focus();
	}

	function handleInput() {
		userTyped = true;
		isOpen = true;
		highlightedIndex = -1;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!isOpen) {
			if (e.key === 'ArrowDown' || e.key === 'Enter') {
				e.preventDefault();
				openDropdown();
			}
			return;
		}

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				highlightedIndex = Math.min(highlightedIndex + 1, filteredModels.length - 1);
				scrollHighlighted();
				break;
			case 'ArrowUp':
				e.preventDefault();
				highlightedIndex = Math.max(highlightedIndex - 1, 0);
				scrollHighlighted();
				break;
			case 'Enter':
				e.preventDefault();
				if (highlightedIndex >= 0 && filteredModels[highlightedIndex]) {
					selectModel(filteredModels[highlightedIndex]);
				}
				break;
			case 'Escape':
				e.preventDefault();
				closeDropdown();
				break;
			case 'Tab':
				// Allow natural tab behavior to close dropdown
				closeDropdown();
				break;
		}
	}

	function scrollHighlighted() {
		if (highlightedIndex >= 0 && listEl) {
			const item = listEl.children[highlightedIndex] as HTMLElement;
			item?.scrollIntoView({ block: 'nearest' });
		}
	}

	function handleBlur(e: FocusEvent) {
		// Delay to allow click on list item
		setTimeout(() => {
			if (!listEl?.contains(document.activeElement)) {
				closeDropdown();
			}
		}, 150);
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest(`.${containerId}`)) {
			closeDropdown();
		}
	}

	const containerId = `model-select-${Math.random().toString(36).slice(2, 8)}`;

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});
</script>

<div class="relative {containerId}">
	<input
		{id}
		type="text"
		class="input w-full pr-8"
		{placeholder}
		{disabled}
		bind:this={inputEl}
		bind:value
		oninput={handleInput}
		onkeydown={handleKeydown}
		onfocus={() => openDropdown()}
		onblur={handleBlur}
		autocomplete="off"
		role="combobox"
		aria-expanded={isOpen}
		aria-haspopup="listbox"
		aria-controls="{id}-listbox"
	/>

	<!-- Loading spinner or chevron -->
	<div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
		{#if isLoading}
			<span class="loading loading-spinner loading-xs text-base-content/40"></span>
		{:else}
			<svg
				class="w-4 h-4 text-base-content/40 transition-transform {isOpen ? 'rotate-180' : ''}"
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 20 20"
				fill="currentColor"
			>
				<path
					fill-rule="evenodd"
					d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
					clip-rule="evenodd"
				/>
			</svg>
		{/if}
	</div>

	<!-- Dropdown list -->
	{#if isOpen && !disabled}
		<ul
			bind:this={listEl}
			id="{id}-listbox"
			role="listbox"
			class="absolute z-50 mt-1 w-full bg-base-200 border border-base-300 rounded-lg shadow-lg max-h-60 overflow-y-auto"
		>
			{#if errorMsg}
				<li class="px-3 py-2 text-sm text-error">{errorMsg}</li>
			{:else if filteredModels.length === 0}
				<li class="px-3 py-2 text-sm text-base-content/40">No models found</li>
			{:else}
				{#each filteredModels as model, i (model)}
					<li
						role="option"
						aria-selected={value === model}
						class="px-3 py-2 text-sm cursor-pointer transition-colors
							{i === highlightedIndex ? 'bg-primary/20' : 'hover:bg-base-300'}
							{value === model ? 'text-primary font-medium' : ''}"
						onclick={() => { hapticLight(); selectModel(model); }}
						onmouseenter={() => { highlightedIndex = i; }}
						onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectModel(model); } }}
						tabindex="0"
					>
						{model}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>