<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticLight, hapticMedium } from '$lib/haptics';
	import PathInput from '$lib/components/PathInput.svelte';

	let {
		open = false,
		defaultRepo = '',
		onclose,
	}: {
		open: boolean;
		defaultRepo?: string;
		onclose: () => void;
	} = $props();

	let title = $state('');
	let description = $state('');
	let repo = $state('');
	let branch = $state('');
	let issueUrl = $state('');
	let targetBranch = $state('main');
	let maxLoops = $state(5);
	let model = $state('');
	let skipReview = $state(true);
	let creating = $state(false);
	let errorMsg = $state('');

	// Reset form when modal opens
	$effect(() => {
		if (open) {
			repo = defaultRepo;
			title = '';
			description = '';
			branch = '';
			issueUrl = '';
			targetBranch = 'main';
			maxLoops = 5;
			model = '';
			skipReview = true;
			errorMsg = '';
		}
	});

	async function handleCreate() {
		if ((!title.trim() && !issueUrl.trim()) || creating) return;
		hapticMedium();
		creating = true;
		errorMsg = '';

		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: title.trim(),
					description: description.trim() || undefined,
					repo: repo.trim() || undefined,
					branch: branch.trim() || undefined,
					issue_url: issueUrl.trim() || undefined,
					target_branch: targetBranch.trim() || undefined,
					max_loops: skipReview ? 0 : maxLoops,
					model: model.trim() || undefined,
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
			errorMsg = e.message || 'Failed to create job';
		} finally {
			creating = false;
		}
	}
</script>

{#if open}
	<dialog class="modal" {open}>
		<div class="modal-box max-w-lg">
			<h3 class="font-bold text-lg">New Job</h3>

			<!-- Issue URL -->
			<div class="form-control mt-4">
				<label class="label" for="job-issue">
					<span class="label-text">Issue URL (optional)</span>
				</label>
				<input
					id="job-issue"
					class="input w-full"
					placeholder="https://github.com/org/repo/issues/123"
					bind:value={issueUrl}
				/>
				{#if issueUrl.trim()}
					<div class="label pb-0">
						<span class="label-text-alt text-base-content/40">Title and description will be fetched from the issue if left empty</span>
					</div>
				{/if}
			</div>

			<!-- Title -->
			<div class="form-control mt-3">
				<label class="label" for="job-title">
					<span class="label-text">Title{issueUrl.trim() ? '' : ' *'}</span>
				</label>
				<input
					id="job-title"
					class="input w-full"
					placeholder={issueUrl.trim() ? 'Auto-filled from issue if empty' : 'e.g. Add user authentication'}
					bind:value={title}
				/>
			</div>

			<!-- Description -->
			<div class="form-control mt-3">
				<label class="label" for="job-description">
					<span class="label-text">Description{issueUrl.trim() ? ' (optional — fetched from issue)' : ' (optional)'}</span>
				</label>
				<textarea
					id="job-description"
					class="textarea textarea-bordered w-full"
					rows="3"
					placeholder="Detailed requirements..."
					bind:value={description}
				></textarea>
			</div>

			<!-- Repository path -->
			<div class="form-control mt-3">
				<label class="label" for="job-repo">
					<span class="label-text">Repository Path</span>
				</label>
				<PathInput
					id="job-repo"
					placeholder="/path/to/repo"
					bind:value={repo}
				/>
			</div>

			<!-- Branch (only for review loop mode — auto-created for fire-and-forget) -->
			{#if !skipReview}
				<div class="form-control mt-3">
					<label class="label" for="job-branch">
						<span class="label-text">Branch (optional — auto-created if empty)</span>
					</label>
					<input
						id="job-branch"
						class="input w-full"
						placeholder="e.g. feat/my-feature"
						bind:value={branch}
					/>
				</div>
			{/if}

			<!-- Model (optional) -->
			<div class="form-control mt-3">
				<label class="label" for="job-model">
					<span class="label-text">Model (optional)</span>
				</label>
				<input
					id="job-model"
					class="input w-full"
					placeholder="e.g. anthropic/claude-sonnet-4"
					bind:value={model}
				/>
			</div>

			<!-- Review loop toggle -->
			<div class="form-control mt-3">
				<label class="label cursor-pointer justify-start gap-3">
					<input
						type="checkbox"
						class="toggle toggle-sm"
						checked={!skipReview}
						onchange={() => { hapticLight(); skipReview = !skipReview; }}
					/>
					<span class="label-text">Enable review loop</span>
				</label>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						{#if skipReview}
							Task runs once with self-review, then completes
						{:else}
							Task → auto-review → fix loop until approved or max loops reached
						{/if}
					</span>
				</div>
			</div>

			{#if !skipReview}
				<!-- Target branch & max loops -->
				<div class="flex gap-3 mt-1">
					<div class="form-control flex-1">
						<label class="label" for="job-target-branch">
							<span class="label-text">Target Branch</span>
						</label>
						<input
							id="job-target-branch"
							class="input w-full"
							placeholder="main"
							bind:value={targetBranch}
						/>
					</div>
					<div class="form-control w-24">
						<label class="label" for="job-max-loops">
							<span class="label-text">Max Loops</span>
						</label>
						<input
							id="job-max-loops"
							type="number"
							class="input w-full"
							min="1"
							max="20"
							bind:value={maxLoops}
						/>
					</div>
				</div>
			{/if}

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleCreate}
					disabled={(!title.trim() && !issueUrl.trim()) || creating}
				>
					{#if creating}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Create Job
					{/if}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') onclose(); }}></div>
	</dialog>
{/if}
