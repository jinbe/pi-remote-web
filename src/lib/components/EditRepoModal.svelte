<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticMedium } from '$lib/haptics';
	import PathInput from '$lib/components/PathInput.svelte';

	interface MonitoredRepo {
		id: string;
		owner: string;
		name: string;
		local_path: string | null;
	}

	let {
		repo,
		onclose,
	}: {
		repo: MonitoredRepo | null;
		onclose: () => void;
	} = $props();

	let localPath = $state('');
	let saving = $state(false);
	let errorMsg = $state('');

	// Reset form when a repo is opened for editing
	$effect(() => {
		if (repo) {
			localPath = repo.local_path ?? '';
			errorMsg = '';
		}
	});

	async function handleSave() {
		if (!repo || saving) return;
		hapticMedium();
		saving = true;
		errorMsg = '';

		try {
			const res = await fetch(`/api/monitored-repos/${repo.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					local_path: localPath.trim() || null,
				}),
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Unknown error' }));
				errorMsg = data.message || `Error: ${res.status}`;
				return;
			}

			onclose();
			invalidateAll();
		} catch (e: any) {
			errorMsg = e.message || 'Failed to save repo';
		} finally {
			saving = false;
		}
	}
</script>

{#if repo}
	<dialog class="modal" open>
		<div class="modal-box max-w-lg">
			<h3 class="font-bold text-lg">Edit {repo.owner}/{repo.name}</h3>

			<div class="form-control mt-4">
				<label class="label" for="edit-repo-local-path">
					<span class="label-text">Local Path</span>
				</label>
				<PathInput
					id="edit-repo-local-path"
					placeholder="/path/to/local/clone"
					bind:value={localPath}
				/>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Used as the working directory when creating review jobs. Leave blank to clear.
					</span>
				</div>
			</div>

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose} disabled={saving}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleSave}
					disabled={saving}
				>
					{#if saving}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Save
					{/if}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') onclose(); }}></div>
	</dialog>
{/if}
