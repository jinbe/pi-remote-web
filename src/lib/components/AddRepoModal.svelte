<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticMedium } from '$lib/haptics';
	import PathInput from '$lib/components/PathInput.svelte';

	let {
		open = false,
		onclose,
	}: {
		open: boolean;
		onclose: () => void;
	} = $props();

	let owner = $state('');
	let name = $state('');
	let localPath = $state('');
	let assignedOnly = $state(true);
	let manualOnly = $state(true);
	let enabled = $state(true);
	let creating = $state(false);
	let errorMsg = $state('');

	// Parse "owner/repo" shorthand into owner + name
	function parseRepoInput() {
		const trimmed = owner.trim();
		if (trimmed.includes('/')) {
			const parts = trimmed.split('/');
			owner = parts[0];
			name = parts.slice(1).join('/');
		}
	}

	// Reset form when modal opens
	$effect(() => {
		if (open) {
			owner = '';
			name = '';
			localPath = '';
			assignedOnly = true;
			manualOnly = true;
			enabled = true;
			errorMsg = '';
		}
	});

	async function handleCreate() {
		if (!owner.trim() || !name.trim() || creating) return;
		hapticMedium();
		creating = true;
		errorMsg = '';

		try {
			const res = await fetch('/api/monitored-repos', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					owner: owner.trim(),
					name: name.trim(),
					local_path: localPath.trim() || undefined,
					assigned_only: assignedOnly,
					manual_only: manualOnly,
					enabled,
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
			errorMsg = e.message || 'Failed to add repo';
		} finally {
			creating = false;
		}
	}
</script>

{#if open}
	<dialog class="modal" {open}>
		<div class="modal-box max-w-lg">
			<h3 class="font-bold text-lg">Add Monitored Repo</h3>

			<!-- Owner -->
			<div class="form-control mt-4">
				<label class="label" for="repo-owner">
					<span class="label-text">Owner / Organisation</span>
				</label>
				<input
					id="repo-owner"
					class="input w-full"
					placeholder="e.g. acme or acme/widget"
					bind:value={owner}
					onblur={parseRepoInput}
				/>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Tip: paste "owner/repo" and it will auto-split
					</span>
				</div>
			</div>

			<!-- Name -->
			<div class="form-control mt-2">
				<label class="label" for="repo-name">
					<span class="label-text">Repository Name</span>
				</label>
				<input
					id="repo-name"
					class="input w-full"
					placeholder="e.g. widget"
					bind:value={name}
				/>
			</div>

			<!-- Local path -->
			<div class="form-control mt-3">
				<label class="label" for="repo-local-path">
					<span class="label-text">Local Path (optional)</span>
				</label>
				<PathInput
					id="repo-local-path"
					placeholder="/path/to/local/clone"
					bind:value={localPath}
				/>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Used as the working directory when creating review jobs
					</span>
				</div>
			</div>

			<!-- Toggles -->
			<div class="mt-4 space-y-3">
				<div class="form-control">
					<label class="label cursor-pointer justify-start gap-3">
						<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={assignedOnly} />
						<div>
							<span class="label-text font-medium">Assigned to me only</span>
							<div class="text-xs text-base-content/50">Only create jobs for PRs assigned to you</div>
						</div>
					</label>
				</div>

				<div class="form-control">
					<label class="label cursor-pointer justify-start gap-3">
						<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={manualOnly} />
						<div>
							<span class="label-text font-medium">Manual trigger only</span>
							<div class="text-xs text-base-content/50">Skip during automatic polling — only scanned when you click the button</div>
						</div>
					</label>
				</div>

				<div class="form-control">
					<label class="label cursor-pointer justify-start gap-3">
						<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={enabled} />
						<div>
							<span class="label-text font-medium">Enabled</span>
							<div class="text-xs text-base-content/50">Master toggle — disabled repos are never scanned</div>
						</div>
					</label>
				</div>
			</div>

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleCreate}
					disabled={!owner.trim() || !name.trim() || creating}
				>
					{#if creating}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Add Repo
					{/if}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') onclose(); }}></div>
	</dialog>
{/if}
