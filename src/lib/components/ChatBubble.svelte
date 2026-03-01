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
						<details class="mt-2 -mx-1 rounded bg-base-300/30">
							<summary class="cursor-pointer text-xs py-1 px-2">
								🔧 {tc.name}
							</summary>
							<pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto px-2 pb-2">{typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments, null, 2)}</pre>
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
