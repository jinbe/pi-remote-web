<script lang="ts">
	import { hapticMedium } from '$lib/haptics';

	let {
		open = false,
		onclose,
	}: {
		open: boolean;
		onclose: () => void;
	} = $props();

	let personalReviewPrompt = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let errorMsg = $state('');

	$effect(() => {
		if (open) {
			errorMsg = '';
			loadSettings();
		}
	});

	async function loadSettings() {
		loading = true;
		try {
			const res = await fetch('/api/settings');
			if (!res.ok) throw new Error(`Load failed: ${res.status}`);
			const data = await res.json();
			personalReviewPrompt = data.personal_review_prompt ?? '';
		} catch (e: any) {
			errorMsg = e.message || 'Failed to load settings';
		} finally {
			loading = false;
		}
	}

	async function handleSave() {
		if (saving) return;
		hapticMedium();
		saving = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ personal_review_prompt: personalReviewPrompt }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Unknown error' }));
				errorMsg = data.message || `Error: ${res.status}`;
				return;
			}
			onclose();
		} catch (e: any) {
			errorMsg = e.message || 'Failed to save settings';
		} finally {
			saving = false;
		}
	}
</script>

{#if open}
	<dialog class="modal" {open}>
		<div class="modal-box max-w-lg max-h-[85vh] overflow-y-auto">
			<h3 class="font-bold text-lg">Settings</h3>

			<div class="form-control mt-4">
				<label class="label" for="personal-review-prompt">
					<span class="label-text">Personal review prompt</span>
				</label>
				<textarea
					id="personal-review-prompt"
					class="textarea w-full font-mono text-sm"
					placeholder="Appended verbatim to every review prompt."
					rows="6"
					disabled={loading}
					bind:value={personalReviewPrompt}
				></textarea>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Added to the end of every review job prompt. Leave blank to disable.
					</span>
				</div>
			</div>

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleSave}
					disabled={loading || saving}
				>
					{#if saving}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Save
					{/if}
				</button>
			</div>
		</div>
		<div
			class="modal-backdrop"
			role="presentation"
			onclick={onclose}
			onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') onclose(); }}
		></div>
	</dialog>
{/if}
