<script lang="ts">
	import type { AgentMessage } from '$lib/types';
	import { getArgs, toolSummary, buildDiffLines } from '$lib/tool-display';
	import { renderMarkdown } from '$lib/markdown';

	let { entry }: { entry: AgentMessage } = $props();

	const role = $derived(entry.message?.role);
	const isUser = $derived(role === 'user');
	const isAssistant = $derived(role === 'assistant');
	const isToolResult = $derived(role === 'toolResult');

	// Copy to clipboard state
	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | undefined;

	function getTextContent(msg: AgentMessage['message']): string {
		if (!msg?.content) return '';
		return msg.content
			.filter((c: any) => c.type === 'text')
			.map((c: any) => c.text || '')
			.join('');
	}

	function getToolCalls(msg: AgentMessage['message']): any[] {
		if (!msg?.content) return [];
		return msg.content.filter((c: any) => c.type === 'toolCall');
	}

	function getThinkingContent(msg: AgentMessage['message']): string {
		if (!msg?.content) return '';
		return msg.content
			.filter((c: any) => c.type === 'thinking')
			.map((c: any) => c.thinking || '')
			.join('');
	}

	function getImages(msg: AgentMessage['message']): Array<{ data: string; mimeType: string }> {
		if (!msg?.content) return [];
		return msg.content
			.filter((c: any) => c.type === 'image' && c.data)
			.map((c: any) => ({ data: c.data, mimeType: c.mimeType || 'image/png' }));
	}

	async function copyToClipboard() {
		const content = text;
		if (!content) return;
		try {
			await navigator.clipboard.writeText(content);
		} catch {
			// Ignore — clipboard API may not be available in all contexts
		}
		copied = true;
		if (copyTimeout) clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => { copied = false; }, 1500);
	}

	const text = $derived(getTextContent(entry.message));
	const toolCalls = $derived(getToolCalls(entry.message));
	const thinking = $derived(getThinkingContent(entry.message));
	const images = $derived(getImages(entry.message));
	const renderedHtml = $derived(isAssistant && text ? renderMarkdown(text) : '');
</script>

{#if entry.type === 'compaction'}
	<div class="divider text-xs text-base-content-faint">
		Context compacted
	</div>
{:else if entry.type === 'message'}
	<div class="chat {isUser ? 'chat-end' : 'chat-start'} mb-3">
		<div class="chat-header text-xs text-base-content-subtle mb-1">
			{#if isUser}
				You
			{:else if isAssistant}
				Assistant
				{#if entry.message?.model}
					<span class="badge badge-xs badge-ghost ml-1">{entry.message.model}</span>
				{/if}
			{:else if isToolResult}
				Tool Result
			{/if}
		</div>
		<div
			class="chat-bubble {isUser
				? 'chat-bubble-primary'
				: isToolResult
					? 'chat-bubble-secondary'
					: ''} max-w-[90vw] md:max-w-xl group/bubble relative"
		>
			<!-- Copy button (shown on hover / focus) -->
			{#if text && !isToolResult}
				<button
					class="copy-btn absolute {isUser ? 'left-0 -translate-x-[calc(100%+4px)]' : 'right-0 translate-x-[calc(100%+4px)]'} top-1 opacity-0 group-hover/bubble:opacity-100 focus:opacity-100 transition-opacity duration-150 btn btn-ghost btn-xs btn-circle text-base-content-muted hover:text-base-content"
					aria-label="Copy message"
					onclick={copyToClipboard}
				>
					{#if copied}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
					{/if}
				</button>
			{/if}

			{#if isToolResult}
				<!-- Tool results: collapsed by default, show truncated preview -->
				<details class="group">
					<summary class="cursor-pointer text-xs font-mono opacity-80">
						🔧 {entry.message?.toolName || 'tool'}
						{#if entry.message?.isError}
							<span class="badge badge-xs badge-error ml-1">error</span>
						{/if}
						<span class="opacity-50 ml-1">({text.length} chars)</span>
					</summary>
					<pre class="mt-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">{text}</pre>
				</details>
			{:else}
				{#if thinking}
					<details class="mb-2 rounded bg-base-300/30 -mx-1">
						<summary class="cursor-pointer text-xs py-1 px-2 opacity-70">Thinking…</summary>
						<div class="text-xs font-mono whitespace-pre-wrap opacity-70 px-2 pb-2 max-h-48 overflow-y-auto">
							{thinking}
						</div>
					</details>
				{/if}

				{#if images.length > 0}
					<div class="flex flex-wrap gap-2 {text ? 'mb-2' : ''}">
						{#each images as img}
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<a href="data:{img.mimeType};base64,{img.data}" target="_blank" rel="noopener noreferrer">
								<img
									src="data:{img.mimeType};base64,{img.data}"
									alt="Attached"
									class="max-h-48 max-w-full rounded-lg border border-base-content/10 hover:opacity-90 transition-opacity"
								/>
							</a>
						{/each}
					</div>
				{/if}

				{#if text}
					{#if isAssistant}
						<div class="markdown-body text-sm">
							{@html renderedHtml}
						</div>
					{:else}
						<div class="whitespace-pre-wrap break-words text-sm">
							{text}
						</div>
					{/if}
				{/if}

				{#if toolCalls.length > 0}
					{#each toolCalls as tc}
						{@const args = getArgs(tc)}
						{@const name = (tc.name || '').toLowerCase()}
						<details class="mt-2 -mx-1 rounded bg-base-300/30">
							<summary class="cursor-pointer text-xs py-1 px-2 flex items-center gap-1.5 min-w-0">
								<span class="flex-shrink-0">
									{#if name === 'bash'}⚡{:else if name === 'read'}📄{:else if name === 'edit'}✏️{:else if name === 'write'}💾{:else if name === 'lsp'}🔍{:else}🔧{/if}
								</span>
								<span class="font-semibold flex-shrink-0">{tc.name}</span>
								<span class="opacity-60 truncate">{toolSummary(tc)}</span>
							</summary>
							<div class="px-2 pb-2 pt-1">
								{#if name === 'bash'}
									<!-- Bash: formatted command block -->
									{#if args.timeout}
										<div class="text-[10px] opacity-50 mb-1">timeout: {args.timeout}s</div>
									{/if}
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content-subtle border-b border-base-content/10 font-mono">$ shell</div>
										<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto p-2 text-success/90">{args.command || ''}</pre>
									</div>
								{:else if name === 'read'}
									<!-- Read: file path with optional range -->
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content-subtle border-b border-base-content/10 font-mono flex items-center gap-2">
											<span>{args.path || ''}</span>
											{#if args.offset || args.limit}
												<span class="opacity-60">
													{#if args.offset}from L{args.offset}{/if}
													{#if args.limit}{args.offset ? ' ' : ''}limit {args.limit}{/if}
												</span>
											{/if}
										</div>
									</div>
								{:else if name === 'edit'}
									<!-- Edit: diff viewer -->
									<div class="text-[10px] opacity-50 mb-1 font-mono">{args.path || ''}</div>
									{#if args.oldText != null && args.newText != null}
										{@const diffLines = buildDiffLines(args.oldText, args.newText)}
										<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden max-h-64 overflow-y-auto">
											<div class="font-mono text-xs leading-relaxed">
												{#each diffLines as line}
													{#if line.type === 'del'}
														<div class="bg-error/15 text-error px-2 whitespace-pre-wrap"><span class="select-none opacity-60">- </span>{line.text}</div>
													{:else if line.type === 'add'}
														<div class="bg-success/15 text-success px-2 whitespace-pre-wrap"><span class="select-none opacity-60">+ </span>{line.text}</div>
													{:else}
														<div class="px-2 opacity-60 whitespace-pre-wrap"><span class="select-none opacity-60">  </span>{line.text}</div>
													{/if}
												{/each}
											</div>
										</div>
									{:else}
										<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">{JSON.stringify(args, null, 2)}</pre>
									{/if}
								{:else if name === 'write'}
									<!-- Write: file path + content preview -->
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content-subtle border-b border-base-content/10 font-mono">{args.path || ''}</div>
										<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto p-2">{args.content || ''}</pre>
									</div>
								{:else if name === 'lsp'}
									<!-- LSP: structured view -->
									{@const lspRestEntries = Object.entries(args).filter(([k]) => !['action', 'file'].includes(k))}
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content-subtle border-b border-base-content/10 font-mono flex items-center gap-2">
											<span class="font-semibold">{args.action || ''}</span>
											{#if args.file}<span class="opacity-60">{args.file}</span>{/if}
										</div>
										{#if lspRestEntries.length > 0}
											<div class="p-2 text-xs font-mono">
												{#each lspRestEntries as [key, val]}
													<div class="flex gap-2"><span class="opacity-50">{key}:</span> <span>{typeof val === 'string' ? val : JSON.stringify(val)}</span></div>
												{/each}
											</div>
										{/if}
									</div>
								{:else}
									<!-- Fallback: pretty JSON -->
									<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">{typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(args, null, 2)}</pre>
								{/if}
							</div>
						</details>
					{/each}
				{/if}
			{/if}

			{#if entry.message?.usage}
				<div class="text-[10px] text-base-content-faint mt-1 text-right">
					{entry.message.usage.input}↓ {entry.message.usage.output}↑
					{#if entry.message.usage.cost?.total}
						· ${entry.message.usage.cost.total.toFixed(4)}
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ── Markdown body styles ─────────────────────────────────────── */

	:global(.markdown-body) {
		line-height: 1.6;
		word-wrap: break-word;
		overflow-wrap: break-word;
	}

	/* Headings */
	:global(.markdown-body h1),
	:global(.markdown-body h2),
	:global(.markdown-body h3),
	:global(.markdown-body h4),
	:global(.markdown-body h5),
	:global(.markdown-body h6) {
		font-weight: 600;
		line-height: 1.3;
		margin-top: 1em;
		margin-bottom: 0.5em;
	}

	:global(.markdown-body h1) { font-size: 1.25em; }
	:global(.markdown-body h2) { font-size: 1.15em; }
	:global(.markdown-body h3) { font-size: 1.05em; }
	:global(.markdown-body h4),
	:global(.markdown-body h5),
	:global(.markdown-body h6) { font-size: 1em; }

	:global(.markdown-body > :first-child) {
		margin-top: 0;
	}

	:global(.markdown-body > :last-child) {
		margin-bottom: 0;
	}

	/* Paragraphs */
	:global(.markdown-body p) {
		margin: 0.5em 0;
	}

	:global(.markdown-body p:first-child) {
		margin-top: 0;
	}

	:global(.markdown-body p:last-child) {
		margin-bottom: 0;
	}

	/* Inline code */
	:global(.markdown-body code) {
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono',
			Menlo, Consolas, 'Liberation Mono', monospace;
		font-size: 0.85em;
		padding: 0.15em 0.35em;
		border-radius: 0.25em;
		background: oklch(0% 0 0 / 0.15);
	}

	/* Code blocks — undo inline code styles inside pre */
	:global(.markdown-body pre code) {
		font-size: 0.8em;
		padding: 0;
		border-radius: 0;
		background: transparent;
	}

	:global(.markdown-body pre) {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		overflow-x: auto;
		max-height: 24rem;
		overflow-y: auto;
		padding: 0.75em;
		line-height: 1.5;
	}

	/* Code block wrapper */
	:global(.markdown-body .code-block-wrapper) {
		position: relative;
		margin: 0.5em 0;
		border-radius: 0.375rem;
		overflow: hidden;
		background: oklch(0% 0 0 / 0.15);
		border: 1px solid oklch(50% 0 0 / 0.1);
	}

	:global(.markdown-body .code-lang) {
		position: absolute;
		top: 0;
		left: 0;
		font-size: 0.65em;
		padding: 0.2em 0.5em;
		opacity: 0.5;
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		user-select: none;
	}

	:global(.markdown-body .code-copy-btn) {
		position: absolute;
		top: 0.25em;
		right: 0.35em;
		font-size: 0.65em;
		padding: 0.15em 0.5em;
		border-radius: 0.25em;
		background: oklch(50% 0 0 / 0.15);
		color: inherit;
		opacity: 0;
		transition: opacity 0.15s;
		cursor: pointer;
		border: 1px solid oklch(50% 0 0 / 0.1);
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
	}

	:global(.markdown-body .code-block-wrapper:hover .code-copy-btn) {
		opacity: 0.8;
	}

	:global(.markdown-body .code-copy-btn:hover) {
		opacity: 1 !important;
		background: oklch(50% 0 0 / 0.25);
	}

	/* Lists */
	:global(.markdown-body ul),
	:global(.markdown-body ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}

	:global(.markdown-body ul) {
		list-style-type: disc;
	}

	:global(.markdown-body ol) {
		list-style-type: decimal;
	}

	:global(.markdown-body li) {
		margin: 0.15em 0;
	}

	:global(.markdown-body li > ul),
	:global(.markdown-body li > ol) {
		margin: 0.1em 0;
	}

	/* Blockquotes */
	:global(.markdown-body blockquote) {
		margin: 0.5em 0;
		padding: 0.25em 0.75em;
		border-left: 3px solid oklch(50% 0 0 / 0.3);
		opacity: 0.85;
	}

	:global(.markdown-body blockquote p) {
		margin: 0.2em 0;
	}

	/* Links */
	:global(.markdown-body a) {
		text-decoration: underline;
		text-underline-offset: 2px;
		opacity: 0.9;
	}

	:global(.markdown-body a:hover) {
		opacity: 1;
	}

	/* Horizontal rule */
	:global(.markdown-body hr) {
		margin: 0.75em 0;
		border: none;
		border-top: 1px solid oklch(50% 0 0 / 0.2);
	}

	/* Tables */
	:global(.markdown-body table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.5em 0;
		font-size: 0.85em;
	}

	:global(.markdown-body th),
	:global(.markdown-body td) {
		padding: 0.35em 0.6em;
		border: 1px solid oklch(50% 0 0 / 0.15);
		text-align: left;
	}

	:global(.markdown-body th) {
		font-weight: 600;
		background: oklch(0% 0 0 / 0.08);
	}

	/* Strong and emphasis */
	:global(.markdown-body strong) {
		font-weight: 600;
	}

	:global(.markdown-body em) {
		font-style: italic;
	}

	/* Task lists (GFM) */
	:global(.markdown-body input[type="checkbox"]) {
		margin-right: 0.3em;
	}

	/* Images in markdown */
	:global(.markdown-body img) {
		max-width: 100%;
		border-radius: 0.375rem;
	}

	/* Mobile: always show copy button on touch devices */
	@media (hover: none) {
		.copy-btn {
			opacity: 0.6 !important;
		}
	}
</style>
