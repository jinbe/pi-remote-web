<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { timeAgo } from '$lib/utils';
	import type { SessionEvent } from '$lib/types';

	type Tab = 'changes' | 'activity';

	let {
		open = false,
		sessionId,
		tab = 'changes',
		events = [],
		ontab,
		onclose,
	}: {
		open: boolean;
		sessionId: string;
		tab?: Tab;
		events?: SessionEvent[];
		ontab?: (next: Tab) => void;
		onclose: () => void;
	} = $props();

	function eventIconName(type: string): IconName | null {
		switch (type) {
			case 'agent_start': return 'play';
			case 'agent_end': return 'stop';
			case 'session_created':
			case 'session_resumed':
			case 'session_started': return 'plus';
			case 'session_stopped':
			case 'session_ended': return 'close';
			case 'compaction_start':
			case 'compaction_end': return 'refresh';
			default: return null;
		}
	}

	function eventLabel(type: string): string {
		switch (type) {
			case 'agent_start': return 'Agent started';
			case 'agent_end': return 'Agent finished';
			case 'session_created': return 'Session created';
			case 'session_resumed': return 'Session resumed';
			case 'session_started': return 'Session started';
			case 'session_stopped': return 'Session stopped';
			case 'session_ended': return 'Session ended';
			case 'compaction_start': return 'Compacting context';
			case 'compaction_end': return 'Compaction complete';
			default: return type;
		}
	}

	interface DiffFile {
		name: string;
		status: string;
	}

	interface DiffData {
		isGitRepo: boolean;
		branch?: string;
		files: DiffFile[];
		diff: string;
		stat?: string;
		truncated?: boolean;
	}

	let loading = $state(true);
	let errorMsg = $state('');
	let data = $state<DiffData | null>(null);
	let selectedFile = $state<string | null>(null);

	// Fetch diff when drawer opens
	$effect(() => {
		if (open) {
			loading = true;
			errorMsg = '';
			data = null;
			selectedFile = null;
			fetchDiff();
		}
	});

	// Close on Escape
	$effect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') onclose();
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	async function fetchDiff() {
		try {
			const res = await fetch(`/api/sessions/${sessionId}/diff`);
			if (!res.ok) {
				errorMsg = `Failed to load diff (${res.status})`;
				return;
			}
			data = await res.json();
		} catch (e: any) {
			errorMsg = e.message || 'Failed to load diff';
		} finally {
			loading = false;
		}
	}

	function statusLabel(status: string): { text: string; cls: string } {
		if (status === '?') return { text: 'new', cls: 'text-secondary border-secondary' };
		if (status.includes('A')) return { text: 'added', cls: 'text-secondary border-secondary' };
		if (status.includes('D')) return { text: 'deleted', cls: 'text-accent border-accent' };
		if (status.includes('R')) return { text: 'renamed', cls: 'text-accent border-accent' };
		return { text: 'modified', cls: 'text-base-content-subtle border-base-300' };
	}

	// Parse diff into per-file hunks
	interface FileDiff {
		filename: string;
		hunks: string;
	}

	const fileDiffs = $derived.by((): FileDiff[] => {
		if (!data?.diff) return [];
		const parts = data.diff.split(/^diff --git /m).filter(Boolean);
		return parts.map((part) => {
			const lines = part.split('\n');
			// Extract filename from "a/path b/path"
			const header = lines[0] ?? '';
			const match = header.match(/b\/(.+)$/);
			const filename = match?.[1] ?? header;
			return { filename, hunks: part };
		});
	});

	// Parse diff text into styled lines
	interface DiffLine {
		text: string;
		type: 'add' | 'remove' | 'context' | 'hunk' | 'header';
	}

	function parseLines(text: string): DiffLine[] {
		if (!text) return [];
		return text.split('\n').map((line): DiffLine => {
			if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file')) {
				return { text: line, type: 'header' };
			}
			if (line.startsWith('@@')) {
				return { text: line, type: 'hunk' };
			}
			if (line.startsWith('+')) {
				return { text: line, type: 'add' };
			}
			if (line.startsWith('-')) {
				return { text: line, type: 'remove' };
			}
			return { text: line, type: 'context' };
		});
	}

	interface ParsedFileDiff {
		filename: string;
		lines: DiffLine[];
	}

	const parsedFileDiffs = $derived.by((): ParsedFileDiff[] => {
		return fileDiffs.map((f) => ({
			filename: f.filename,
			lines: parseLines(`diff --git ${f.hunks}`)
		}));
	});

	const selectedFileDiff = $derived.by((): ParsedFileDiff | null => {
		if (!selectedFile) return null;
		return parsedFileDiffs.find((f) => f.filename === selectedFile) ?? null;
	});

	const allLines = $derived(parsedFileDiffs.flatMap((f) => f.lines));
	const addCount = $derived(allLines.filter((l) => l.type === 'add').length);
	const removeCount = $derived(allLines.filter((l) => l.type === 'remove').length);
</script>

<!-- Backdrop -->
<div
	class="drawer-backdrop"
	class:open
	role="presentation"
	onclick={onclose}
	onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
></div>

<!-- Drawer -->
<aside
	class="drawer"
	class:open
	aria-label={tab === 'activity' ? 'Activity log' : 'Changes'}
	aria-hidden={!open}
>
	<!-- Header: tab strip + close -->
	<div class="flex items-stretch justify-between border-b border-base-300 shrink-0">
		<div class="flex" role="tablist">
			<button
				role="tab"
				aria-selected={tab === 'changes'}
				class="px-4 py-3 text-[13px] font-medium transition-colors {tab === 'changes' ? 'border-b-2 border-base-content -mb-px text-base-content' : 'text-base-content-subtle hover:text-base-content'}"
				onclick={() => ontab?.('changes')}
			>
				Changes
				{#if tab === 'changes' && data && !loading}
					<span class="ml-2 font-mono text-[11px]">
						<span class="text-secondary">+{addCount}</span>
						<span class="text-accent ml-1">−{removeCount}</span>
					</span>
				{/if}
			</button>
			<button
				role="tab"
				aria-selected={tab === 'activity'}
				class="px-4 py-3 text-[13px] font-medium transition-colors {tab === 'activity' ? 'border-b-2 border-base-content -mb-px text-base-content' : 'text-base-content-subtle hover:text-base-content'}"
				onclick={() => ontab?.('activity')}
			>
				Activity
				{#if tab === 'activity' && events.length > 0}
					<span class="ml-2 text-[11px] text-base-content-subtle">{events.length}</span>
				{/if}
			</button>
		</div>
		<div class="flex items-center gap-2 px-3">
			{#if tab === 'changes' && data?.branch}
				<span class="hidden sm:inline-flex font-mono text-[11px] text-base-content-subtle border border-base-300 px-2 py-0.5">⎇ {data.branch}</span>
			{/if}
			<button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close drawer">
				<Icon name="close" class="w-4 h-4" />
			</button>
		</div>
	</div>

	{#if tab === 'activity'}
		<div class="flex-1 overflow-y-auto p-2 space-y-1">
			{#if events.length === 0}
				<div class="text-xs text-base-content-faint p-4 text-center">No events yet</div>
			{:else}
				{#each events as event (event.id)}
					{@const iconName = eventIconName(event.event_type)}
					<div class="text-xs flex items-start gap-2 py-1.5 px-2 hover:bg-base-200 transition-colors">
						<span class="inline-flex items-center text-base-content-subtle mt-0.5">
							{#if iconName}<Icon name={iconName} class="w-3.5 h-3.5" />{:else}•{/if}
						</span>
						<div class="flex-1 min-w-0">
							<div class="font-medium">{eventLabel(event.event_type)}</div>
							<div class="text-base-content-faint">{timeAgo(event.timestamp)}</div>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{:else if loading}
		<div class="flex-1 flex items-center justify-center">
			<span class="loading loading-spinner loading-md"></span>
		</div>
	{:else if errorMsg}
		<div class="flex-1 flex items-center justify-center">
			<div class="alert alert-error max-w-sm">{errorMsg}</div>
		</div>
	{:else if data && !data.isGitRepo}
		<div class="flex-1 flex items-center justify-center text-base-content-subtle">
			Not a git repository
		</div>
	{:else if data && data.files.length === 0}
		<div class="flex-1 flex items-center justify-center text-base-content-subtle">
			<div class="text-center">
				<div class="text-3xl mb-2"><Icon name="check" class="w-8 h-8 mx-auto" /></div>
				<div>Working tree clean</div>
			</div>
		</div>
	{:else if data}
		<div class="flex-1 flex flex-col md:flex-row overflow-hidden">
			<!-- File list -->
			<div class="shrink-0 md:w-56 border-b md:border-b-0 md:border-r border-base-300 overflow-x-auto md:overflow-y-auto">
				<div class="flex md:flex-col p-2 gap-0.5 min-w-max md:min-w-0">
					<button
						class="text-left text-xs px-2 py-1.5 truncate transition-colors
							{selectedFile === null ? 'bg-base-content text-base-100 font-semibold' : 'hover:bg-base-200'}"
						onclick={() => (selectedFile = null)}
					>
						All files ({data.files.length})
					</button>
					{#each data.files as file}
						{@const sl = statusLabel(file.status)}
						<button
							class="text-left text-xs px-2 py-1.5 truncate flex items-center gap-1.5 transition-colors
								{selectedFile === file.name ? 'bg-base-content text-base-100 font-semibold' : 'hover:bg-base-200'}"
							onclick={() => (selectedFile = file.name)}
							title={file.name}
						>
							<span class="text-[9.5px] uppercase tracking-[0.08em] border px-1 py-px shrink-0 {selectedFile === file.name ? 'border-current opacity-80' : sl.cls}">{sl.text}</span>
							<span class="truncate font-mono">{file.name.split('/').pop()}</span>
						</button>
					{/each}
				</div>
			</div>

			<!-- Diff view -->
			<div class="flex-1 overflow-auto">
				{#if selectedFile}
					{#if selectedFileDiff && selectedFileDiff.lines.length > 0}
						<pre class="text-xs leading-relaxed"><code>{#each selectedFileDiff.lines as line}<span class="diff-line {line.type}">{line.text}
</span>{/each}</code></pre>
					{:else}
						<div class="flex items-center justify-center h-full text-base-content-subtle text-sm">
							No diff for this file (may be untracked)
						</div>
					{/if}
				{:else if parsedFileDiffs.length === 0}
					<div class="flex items-center justify-center h-full text-base-content-subtle text-sm">
						No diff content
					</div>
				{:else}
					{#each parsedFileDiffs as fileDiff, i}
						{#if i > 0}
							<div class="file-separator"></div>
						{/if}
						<div class="file-block">
							<div class="file-name">{fileDiff.filename}</div>
							<pre class="text-xs leading-relaxed"><code>{#each fileDiff.lines as line}<span class="diff-line {line.type}">{line.text}
</span>{/each}</code></pre>
						</div>
					{/each}
				{/if}
				{#if data.truncated}
					<div class="p-3 text-center text-xs text-accent border-t border-base-300">
						Diff truncated (too large to display in full)
					</div>
				{/if}
			</div>
		</div>
	{/if}
</aside>

<style>
	.drawer-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.32);
		opacity: 0;
		pointer-events: none;
		transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1);
		z-index: 60;
	}
	.drawer-backdrop.open {
		opacity: 1;
		pointer-events: auto;
	}

	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(720px, 100vw);
		background: var(--color-base-100);
		border-left: 1px solid var(--color-base-300);
		display: flex;
		flex-direction: column;
		z-index: 61;
		transform: translateX(100%);
		transition: transform 240ms cubic-bezier(0.2, 0, 0, 1);
		padding-top: env(safe-area-inset-top);
		padding-right: env(safe-area-inset-right);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.drawer.open {
		transform: translateX(0);
	}

	@media (max-width: 640px) {
		.drawer {
			width: 100vw;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.drawer,
		.drawer-backdrop {
			transition: none;
		}
	}

	pre {
		margin: 0;
		tab-size: 4;
	}

	pre code {
		display: block;
	}

	.diff-line {
		display: block;
		padding: 0 1rem;
		min-height: 1.4em;
		white-space: pre;
	}

	.diff-line.add {
		background-color: rgba(31, 91, 101, 0.12);
		color: var(--color-secondary);
	}

	.diff-line.remove {
		background-color: rgba(254, 73, 26, 0.10);
		color: var(--color-accent);
	}

	.diff-line.hunk {
		color: var(--color-base-content-subtle);
		background-color: var(--color-base-200);
		font-weight: 600;
	}

	.diff-line.header {
		color: var(--color-base-content-faint);
		font-weight: 700;
	}

	.diff-line.context {
		color: var(--color-base-content-muted);
	}

	.file-separator {
		height: 1px;
		background: var(--color-base-300);
		margin: 1rem 0;
	}

	.file-name {
		position: sticky;
		top: 0;
		z-index: 1;
		padding: 0.375rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		font-family: ui-monospace, monospace;
		background: var(--color-base-200);
		border-bottom: 1px solid var(--color-base-300);
	}
</style>
