<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		open = false,
		sessionId,
		onclose
	}: {
		open: boolean;
		sessionId: string;
		onclose: () => void;
	} = $props();

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

	// Fetch diff when modal opens
	$effect(() => {
		if (open) {
			loading = true;
			errorMsg = '';
			data = null;
			selectedFile = null;
			fetchDiff();
		}
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
		if (status === '?') return { text: 'new', cls: 'badge-success' };
		if (status.includes('A')) return { text: 'added', cls: 'badge-success' };
		if (status.includes('D')) return { text: 'deleted', cls: 'badge-error' };
		if (status.includes('R')) return { text: 'renamed', cls: 'badge-warning' };
		return { text: 'modified', cls: 'badge-info' };
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

{#if open}
	<dialog class="modal" open>
		<div class="modal-box max-w-4xl w-[95vw] h-[85vh] flex flex-col p-0">
			<!-- Header -->
			<div class="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
				<div class="flex items-center gap-2">
					<h3 class="font-bold text-lg">Changes</h3>
					{#if data?.branch}
						<span class="badge badge-sm badge-outline font-mono gap-0.5">⎇ {data.branch}</span>
					{/if}
					{#if data && !loading}
						<span class="text-xs text-base-content/50">
							<span class="text-success">+{addCount}</span>
							<span class="text-error ml-1">−{removeCount}</span>
						</span>
					{/if}
				</div>
				<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose}><Icon name="close" class="w-4 h-4" /></button>
			</div>

			{#if loading}
				<div class="flex-1 flex items-center justify-center">
					<span class="loading loading-spinner loading-md"></span>
				</div>
			{:else if errorMsg}
				<div class="flex-1 flex items-center justify-center">
					<div class="alert alert-error max-w-sm">{errorMsg}</div>
				</div>
			{:else if data && !data.isGitRepo}
				<div class="flex-1 flex items-center justify-center text-base-content/50">
					Not a git repository
				</div>
			{:else if data && data.files.length === 0}
				<div class="flex-1 flex items-center justify-center text-base-content/50">
					<div class="text-center">
						<div class="text-3xl mb-2"><Icon name="check" class="w-8 h-8 mx-auto" /></div>
						<div>Working tree clean</div>
					</div>
				</div>
			{:else if data}
				<div class="flex-1 flex flex-col md:flex-row overflow-hidden">
					<!-- File list sidebar -->
					<div class="shrink-0 md:w-56 border-b md:border-b-0 md:border-r border-base-300 overflow-x-auto md:overflow-y-auto">
						<div class="flex md:flex-col p-2 gap-0.5 min-w-max md:min-w-0">
							<button
								class="text-left text-xs px-2 py-1.5 rounded truncate transition-colors
									{selectedFile === null ? 'bg-primary/15 text-primary font-semibold' : 'hover:bg-base-300/50'}"
								onclick={() => (selectedFile = null)}
							>
								All files ({data.files.length})
							</button>
							{#each data.files as file}
								{@const sl = statusLabel(file.status)}
								<button
									class="text-left text-xs px-2 py-1.5 rounded truncate flex items-center gap-1.5 transition-colors
										{selectedFile === file.name ? 'bg-primary/15 text-primary font-semibold' : 'hover:bg-base-300/50'}"
									onclick={() => (selectedFile = file.name)}
									title={file.name}
								>
									<span class="badge badge-xs {sl.cls} shrink-0">{sl.text}</span>
									<span class="truncate">{file.name.split('/').pop()}</span>
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
								<div class="flex items-center justify-center h-full text-base-content/50 text-sm">
									No diff for this file (may be untracked)
								</div>
							{/if}
						{:else if parsedFileDiffs.length === 0}
							<div class="flex items-center justify-center h-full text-base-content/50 text-sm">
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
							<div class="p-3 text-center text-xs text-warning border-t border-base-300">
								Diff truncated (too large to display in full)
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={onclose}></div>
	</dialog>
{/if}

<style>
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
		background-color: oklch(0.75 0.15 145 / 0.15);
		color: oklch(0.75 0.15 145);
	}

	.diff-line.remove {
		background-color: oklch(0.65 0.2 25 / 0.15);
		color: oklch(0.65 0.2 25);
	}

	.diff-line.hunk {
		color: oklch(0.65 0.15 250);
		background-color: oklch(0.65 0.15 250 / 0.08);
		font-weight: 600;
	}

	.diff-line.header {
		color: oklch(0.65 0 0);
		font-weight: 700;
	}

	.diff-line.context {
		opacity: 0.7;
	}

	.file-separator {
		height: 1px;
		background: oklch(0.5 0 0 / 0.15);
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
		background: oklch(0.5 0.02 250 / 0.1);
		border-bottom: 1px solid oklch(0.5 0 0 / 0.1);
	}
</style>
