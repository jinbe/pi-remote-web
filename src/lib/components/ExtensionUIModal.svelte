<script lang="ts">
	import type { ExtensionUIRequest } from '$lib/types';

	let {
		request = null,
		sessionId,
		onclose
	}: {
		request: ExtensionUIRequest | null;
		sessionId: string;
		onclose: () => void;
	} = $props();

	let inputValue = $state('');
	let selectedOption = $state('');

	$effect(() => {
		if (request) {
			inputValue = request.prefill ?? '';
			selectedOption = '';

			if (request.timeout) {
				const timer = setTimeout(() => dismiss(), request.timeout);
				return () => clearTimeout(timer);
			}
		}
	});

	async function sendResponse(responsePayload: Record<string, any>) {
		if (!request) return;
		await fetch(`/api/sessions/${sessionId}/extension-ui-response`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: request.id,
				type: 'extension_ui_response',
				...responsePayload
			})
		});
		onclose();
	}

	function dismiss() {
		sendResponse({ cancelled: true });
	}
</script>

{#if request}
	<dialog class="modal" open>
		<div class="modal-box">
			{#if request.method === 'input'}
				<h3 class="font-bold text-lg">{request.title ?? 'Input'}</h3>
				<p class="py-2">{request.message ?? ''}</p>
				<input class="input w-full" bind:value={inputValue} placeholder={request.placeholder ?? ''} />
				<div class="modal-action">
					<button class="btn" onclick={dismiss}>Cancel</button>
					<button class="btn btn-primary" onclick={() => sendResponse({ value: inputValue })}>Submit</button>
				</div>
			{:else if request.method === 'confirm'}
				<h3 class="font-bold text-lg">{request.title ?? 'Confirm'}</h3>
				<p class="py-4">{request.message}</p>
				<div class="modal-action">
					<button class="btn" onclick={() => sendResponse({ confirmed: false })}>No</button>
					<button class="btn btn-primary" onclick={() => sendResponse({ confirmed: true })}>Yes</button>
				</div>
			{:else if request.method === 'select'}
				<h3 class="font-bold text-lg">{request.title ?? 'Select'}</h3>
				<div class="flex flex-col gap-2 max-h-64 overflow-y-auto py-2">
					{#each request.options ?? [] as option}
						<label class="flex items-start gap-3 p-2 rounded hover:bg-base-200 cursor-pointer">
							<input
								type="radio"
								name="ext-select"
								class="radio radio-primary mt-1"
								checked={selectedOption === option}
								onchange={() => (selectedOption = option)}
							/>
							<div class="font-medium">{option}</div>
						</label>
					{/each}
				</div>
				<div class="modal-action">
					<button class="btn" onclick={dismiss}>Cancel</button>
					<button class="btn btn-primary" onclick={() => sendResponse({ value: selectedOption })}>OK</button>
				</div>
			{:else if request.method === 'editor'}
				<h3 class="font-bold text-lg">{request.title ?? 'Editor'}</h3>
				<textarea class="textarea w-full h-48 font-mono" bind:value={inputValue}></textarea>
				<div class="modal-action">
					<button class="btn" onclick={dismiss}>Cancel</button>
					<button class="btn btn-primary" onclick={() => sendResponse({ value: inputValue })}>Save</button>
				</div>
			{/if}
		</div>
		<div class="modal-backdrop" role="presentation" onclick={dismiss} onkeydown={dismiss}></div>
	</dialog>
{/if}
