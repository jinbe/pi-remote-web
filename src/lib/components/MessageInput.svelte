<script lang="ts">
	let {
		sessionId,
		disabled = false
	}: {
		sessionId: string;
		disabled?: boolean;
	} = $props();

	let message = $state('');
	let behavior = $state<'send' | 'steer' | 'followUp'>('send');
	let sending = $state(false);

	async function handleSend() {
		if (!message.trim() || sending) return;
		sending = true;

		try {
			const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: message.trim(),
					behavior: behavior === 'send' ? undefined : behavior
				})
			});

			if (res.ok) {
				message = '';
			}
		} finally {
			sending = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}
</script>

<div class="border-t border-base-300 bg-base-200 p-3">
	<div class="flex gap-2">
		<textarea
			class="textarea flex-1 min-h-[2.5rem] max-h-32 resize-none"
			placeholder="Type a message..."
			bind:value={message}
			onkeydown={handleKeydown}
			{disabled}
			rows={1}
		></textarea>
		<button
			class="btn btn-primary btn-sm self-end"
			onclick={handleSend}
			disabled={disabled || !message.trim() || sending}
		>
			{#if sending}
				<span class="loading loading-spinner loading-xs"></span>
			{:else}
				⏎
			{/if}
		</button>
	</div>
	<div class="mt-2 flex gap-2 text-xs">
		<label class="flex items-center gap-1 cursor-pointer">
			<input type="radio" name="behavior" class="radio radio-xs" value="send" bind:group={behavior} />
			Send
		</label>
		<label class="flex items-center gap-1 cursor-pointer">
			<input type="radio" name="behavior" class="radio radio-xs" value="steer" bind:group={behavior} />
			Steer
		</label>
		<label class="flex items-center gap-1 cursor-pointer">
			<input type="radio" name="behavior" class="radio radio-xs" value="followUp" bind:group={behavior} />
			Follow-up
		</label>
	</div>
</div>
