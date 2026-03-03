<script lang="ts">
	import type { AgentMessage } from '$lib/types';

	let { entry }: { entry: AgentMessage } = $props();

	const role = $derived(entry.message?.role);
	const isUser = $derived(role === 'user');
	const isAssistant = $derived(role === 'assistant');
	const isToolResult = $derived(role === 'toolResult');

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

	function truncate(s: string, max: number): string {
		if (s.length <= max) return s;
		return s.slice(0, max) + '…';
	}

	function getArgs(tc: any): Record<string, any> {
		if (!tc.arguments) return {};
		if (typeof tc.arguments === 'string') {
			try { return JSON.parse(tc.arguments); } catch { return {}; }
		}
		return tc.arguments;
	}

	/** Short summary shown next to the tool icon in the collapsed state */
	function toolSummary(tc: any): string {
		const args = getArgs(tc);
		const name = (tc.name || '').toLowerCase();
		if (name === 'bash') {
			const cmd = args.command || '';
			// Show first line, truncated
			const firstLine = cmd.split('\n')[0];
			return truncate(firstLine, 60);
		}
		if (name === 'read') {
			let s = shortPath(args.path || '');
			if (args.offset) s += `:${args.offset}`;
			if (args.limit) s += `+${args.limit}`;
			return s;
		}
		if (name === 'edit') {
			return shortPath(args.path || '');
		}
		if (name === 'write') {
			return shortPath(args.path || '');
		}
		if (name === 'lsp') {
			let s = args.action || '';
			if (args.query) s += ` ${args.query}`;
			if (args.file) s += ` ${shortPath(args.file)}`;
			return s;
		}
		return '';
	}

	function shortPath(p: string): string {
		if (!p) return '';
		const parts = p.split('/');
		if (parts.length <= 3) return p;
		return '…/' + parts.slice(-2).join('/');
	}

	/** Build a simple unified-diff style view from oldText → newText */
	function buildDiffLines(oldText: string, newText: string): { type: 'ctx' | 'del' | 'add'; text: string }[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const result: { type: 'ctx' | 'del' | 'add'; text: string }[] = [];

		// Simple LCS-based diff
		const m = oldLines.length;
		const n = newLines.length;

		// For very large texts, fall back to simple before/after
		if (m + n > 200) {
			for (const l of oldLines) result.push({ type: 'del', text: l });
			for (const l of newLines) result.push({ type: 'add', text: l });
			return result;
		}

		// Build LCS table
		const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (oldLines[i - 1] === newLines[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		// Backtrack to build diff
		const raw: { type: 'ctx' | 'del' | 'add'; text: string }[] = [];
		let i = m, j = n;
		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
				raw.unshift({ type: 'ctx', text: oldLines[i - 1] });
				i--; j--;
			} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
				raw.unshift({ type: 'add', text: newLines[j - 1] });
				j--;
			} else {
				raw.unshift({ type: 'del', text: oldLines[i - 1] });
				i--;
			}
		}

		return raw;
	}

	const text = $derived(getTextContent(entry.message));
	const toolCalls = $derived(getToolCalls(entry.message));
	const thinking = $derived(getThinkingContent(entry.message));
</script>

{#if entry.type === 'compaction'}
	<div class="divider text-xs text-base-content/40">
		Context compacted
	</div>
{:else if entry.type === 'message'}
	<div class="chat {isUser ? 'chat-end' : 'chat-start'} mb-2">
		<div class="chat-header text-xs text-base-content/50 mb-1">
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
					: ''} max-w-[85vw] md:max-w-xl"
		>
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

				{#if text}
					<div class="whitespace-pre-wrap break-words text-sm">
						{text}
					</div>
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
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content/50 border-b border-base-content/10 font-mono">$ shell</div>
										<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto p-2 text-success/90">{args.command || ''}</pre>
									</div>
								{:else if name === 'read'}
									<!-- Read: file path with optional range -->
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content/50 border-b border-base-content/10 font-mono flex items-center gap-2">
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
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content/50 border-b border-base-content/10 font-mono">{args.path || ''}</div>
										<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto p-2">{args.content || ''}</pre>
									</div>
								{:else if name === 'lsp'}
									<!-- LSP: structured view -->
									{@const lspRestEntries = Object.entries(args).filter(([k]) => !['action', 'file'].includes(k))}
									<div class="rounded bg-base-100/40 border border-base-content/10 overflow-hidden">
										<div class="text-[10px] px-2 py-0.5 bg-base-content/5 text-base-content/50 border-b border-base-content/10 font-mono flex items-center gap-2">
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
				<div class="text-[10px] text-base-content/30 mt-1 text-right">
					{entry.message.usage.input}↓ {entry.message.usage.output}↑
					{#if entry.message.usage.cost?.total}
						· ${entry.message.usage.cost.total.toFixed(4)}
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
