<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { hapticLight, hapticMedium } from '$lib/haptics';

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
	let reviewSkill = $state('');
	let model = $state('');
	let skipReview = $state(false);
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
			reviewSkill = '';
			model = '';
			skipReview = false;
			errorMsg = '';
		}
	});

	async function handleCreate() {
		if (!title.trim() || creating) return;
		hapticMedium();
		creating = true;
		errorMsg = '';

		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// No type — defaults to 'task' in the backend
					title: title.trim(),
					description: description.trim() || undefined,
					repo: repo.trim() || undefined,
					branch: branch.trim() || undefined,
					issue_url: issueUrl.trim() || undefined,
					target_branch: targetBranch.trim() || undefined,
					max_loops: skipReview ? 0 : maxLoops,
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
			<p class="text-sm mt-1 text-base-content/60">
				Jobs automatically run task → review → fix loops until approved or max loops reached.
			</p>

			<!-- Title -->
			<div class="form-control mt-4">
				<label class="label" for="job-title">
					<span class="label-text">Title</span>
				</label>
				<input
					id="job-title"
					class="input w-full"
					placeholder="e.g. Add user authentication"
					bind:value={title}
				/>
			</div>

			<!-- Description -->
			<div class="form-control mt-3">
				<label class="label" for="job-description">
					<span class="label-text">Description (optional)</span>
				</label>
				<textarea
					id="job-description"
					class="textarea textarea-bordered w-full"
					rows="3"
					placeholder="Detailed requirements or review instructions..."
					bind:value={description}
				></textarea>
			</div>

			<!-- Repository path -->
			<div class="form-control mt-3">
				<label class="label" for="job-repo">
					<span class="label-text">Repository Path</span>
				</label>
				<input
					id="job-repo"
					class="input w-full"
					placeholder="/path/to/repo"
					bind:value={repo}
				/>
			</div>

			<!-- Branch -->
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

			<!-- Issue URL -->
			<div class="form-control mt-3">
				<label class="label" for="job-issue">
					<span class="label-text">Issue URL (optional)</span>
				</label>
				<input
					id="job-issue"
					class="input w-full"
					placeholder="https://github.com/org/repo/issues/123"
					bind:value={issueUrl}
				/>
			</div>

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

			<!-- Skip review toggle -->
			<div class="form-control mt-3">
				<label class="label cursor-pointer justify-start gap-3">
					<input
						type="checkbox"
						class="toggle toggle-sm"
						bind:checked={skipReview}
					/>
					<span class="label-text">Skip review (fire-and-forget)</span>
				</label>
			</div>

			{#if !skipReview}
				<!-- Target branch & max loops -->
				<div class="flex gap-3 mt-3">
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

				<!-- Review skill (optional — used during the auto-review phase) -->
				<div class="form-control mt-3">
					<label class="label" for="job-review-skill">
						<span class="label-text">Review Skill (optional)</span>
					</label>
					<input
						id="job-review-skill"
						class="input w-full"
						placeholder="e.g. skill:review, multi-review, or /path/to/skill"
						bind:value={reviewSkill}
					/>
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
					disabled={!title.trim() || creating}
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
