<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticMedium } from '$lib/haptics';

	let {
		open = false,
		defaultRepo = '',
		onclose,
	}: {
		open: boolean;
		defaultRepo?: string;
		onclose: () => void;
	} = $props();

	let repo = $state('');
	let prUrl = $state('');
	let branch = $state('');
	let targetBranch = $state('');
	let reviewSkill = $state('');
	let model = $state('');
	let maxLoops = $state(1);
	let creating = $state(false);
	let errorMsg = $state('');

	// Reset form when modal opens
	$effect(() => {
		if (open) {
			repo = defaultRepo;
			prUrl = '';
			branch = '';
			targetBranch = '';
			reviewSkill = '';
			model = '';
			maxLoops = 1;
			errorMsg = '';
		}
	});

	async function handleCreate() {
		if (!prUrl.trim() || creating) return;
		hapticMedium();
		creating = true;
		errorMsg = '';

		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'review',
					repo: repo.trim() || undefined,
					pr_url: prUrl.trim(),
					branch: branch.trim() || undefined,
					target_branch: targetBranch.trim() || undefined,
					max_loops: maxLoops,
					review_skill: reviewSkill.trim() || undefined,
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
			errorMsg = e.message || 'Failed to create review job';
		} finally {
			creating = false;
		}
	}
</script>

{#if open}
	<dialog class="modal" {open}>
		<div class="modal-box max-w-lg">
			<h3 class="font-bold text-lg">New Review Job</h3>

			<!-- PR URL (primary field) -->
			<div class="form-control mt-4">
				<label class="label" for="review-pr-url">
					<span class="label-text">PR URL</span>
				</label>
				<input
					id="review-pr-url"
					class="input w-full"
					placeholder="https://github.com/org/repo/pull/42"
					bind:value={prUrl}
				/>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Title, branch, and target branch are inferred from the PR
					</span>
				</div>
			</div>

			<!-- Repository path -->
			<div class="form-control mt-3">
				<label class="label" for="review-repo">
					<span class="label-text">Repository Path</span>
				</label>
				<input
					id="review-repo"
					class="input w-full"
					placeholder="/path/to/repo"
					bind:value={repo}
				/>
			</div>

			<!-- Branch -->
			<div class="form-control mt-3">
				<label class="label" for="review-branch">
					<span class="label-text">Branch (optional override)</span>
				</label>
				<input
					id="review-branch"
					class="input w-full"
					placeholder="Inferred from PR"
					bind:value={branch}
				/>
			</div>

			<!-- Target branch & max loops -->
			<div class="flex gap-3 mt-3">
				<div class="form-control flex-1">
					<label class="label" for="review-target-branch">
						<span class="label-text">Target Branch (optional override)</span>
					</label>
					<input
						id="review-target-branch"
						class="input w-full"
						placeholder="Inferred from PR"
						bind:value={targetBranch}
					/>
				</div>
				<div class="form-control w-24">
					<label class="label" for="review-max-loops">
						<span class="label-text">Max Loops</span>
					</label>
					<input
						id="review-max-loops"
						type="number"
						class="input w-full"
						min="1"
						max="20"
						bind:value={maxLoops}
					/>
				</div>
			</div>

			<!-- Review skill -->
			<div class="form-control mt-3">
				<label class="label" for="review-skill">
					<span class="label-text">Review Skill (optional)</span>
				</label>
				<input
					id="review-skill"
					class="input w-full"
					placeholder="e.g. review"
					bind:value={reviewSkill}
				/>
				<div class="label pt-0">
					<span class="label-text-alt text-base-content/40">
						Overrides PI_JOB_REVIEW_SKILL for this job
					</span>
				</div>
			</div>

			<!-- Model (optional) -->
			<div class="form-control mt-3">
				<label class="label" for="review-model">
					<span class="label-text">Model (optional)</span>
				</label>
				<input
					id="review-model"
					class="input w-full"
					placeholder="e.g. anthropic/claude-sonnet-4"
					bind:value={model}
				/>
			</div>

			{#if errorMsg}
				<div class="alert alert-error mt-4 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={onclose}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={handleCreate}
					disabled={!prUrl.trim() || creating}
				>
					{#if creating}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Create Review
					{/if}
				</button>
			</div>
		</div>
		<div class="modal-backdrop" role="presentation" onclick={onclose} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') onclose(); }}></div>
	</dialog>
{/if}
