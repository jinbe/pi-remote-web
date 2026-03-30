<script lang="ts">
	import { goto } from '$app/navigation';
	import { hapticLight, hapticMedium } from '$lib/haptics';
	import PathInput from '$lib/components/PathInput.svelte';

	let {
		open = false,
		defaultCwd = '',
		recentCwds = [],
		recentModels = [],
		onclose
	}: {
		open: boolean;
		defaultCwd?: string;
		recentCwds?: string[];
		recentModels?: string[];
		onclose: () => void;
	} = $props();

	let cwd = $state('');
	let model = $state('');

	// Pre-fill cwd from defaultCwd when modal opens
	$effect(() => {
		if (open && defaultCwd && !cwd) {
			cwd = defaultCwd;
		}
	});
	let creating = $state(false);
	let errorMsg = $state('');

	async function handleCreate() {
		if (!cwd.trim() || creating) return;
		hapticMedium();
		creating = true;
		errorMsg = '';

		try {
			const res = await fetch('/api/sessions/new', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cwd: cwd.trim(),
					model: model.trim() || undefined
				})
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Unknown error' }));
				errorMsg = data.message || `Error: ${res.status}`;
				return;
			}

			const data = await res.json();
			onclose();
			goto(`/session/${data.sessionId}?new=1`);
		} catch (e: any) {
			errorMsg = e.message || 'Failed to create session';
		} finally {
			creating = false;
		}
	}
</script>

{#if open}
	<dialog class="modal" {open}>
		<div class="modal-box">
			<h3 class="font-bold text-lg">New Session</h3>

			<div class="form-control mt-4">
				<label class="label" for="cwd-input">
					<span class="label-text">Working Directory</span>
				</label>
				<PathInput
					id="cwd-input"
					placeholder="/path/to/project"
					bind:value={cwd}
				/>
				{#if recentCwds.length > 0}
					<div class="mt-2 flex flex-wrap gap-1">
						{#each recentCwds.slice(0, 5) as rc}
							<button class="badge badge-outline badge-sm cursor-pointer" onclick={() => { hapticLight(); cwd = rc; }}>
								{rc.split('/').pop()}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div class="form-control mt-4">
				<label class="label" for="model-input">
					<span class="label-text">Model (optional)</span>
				</label>
				<input
					id="model-input"
					class="input w-full"
					placeholder="e.g. anthropic/claude-sonnet-4"
					bind:value={model}
				/>
				{#if recentModels.length > 0}
					<div class="mt-2 flex flex-wrap gap-1">
						{#each recentModels.slice(0, 5) as rm}
							<button class="badge badge-outline badge-sm cursor-pointer" onclick={() => { hapticLight(); model = rm; }}>
								{rm}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleCreate}
					disabled={!cwd.trim() || creating}
				>
					{#if creating}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Create
					{/if}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={onclose}></div>
	</dialog>
{/if}
