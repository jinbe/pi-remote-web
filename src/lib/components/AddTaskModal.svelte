<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';

	interface Worktree {
		id: string;
		repo: string;
		slug: string;
		status: string;
	}

	interface Props {
		open: boolean;
		repoPaths: string[];
		worktrees: Worktree[];
		onclose: () => void;
	}

	let { open, repoPaths, worktrees, onclose }: Props = $props();

	let mode = $state<'new' | 'existing'>('new');
	let title = $state('');
	let description = $state('');
	let sourceUrl = $state('');
	let repo = $state('');
	let existingWorktreeId = $state('');
	let busy = $state(false);
	let err = $state<string | null>(null);

	const eligibleWorktrees = $derived(
		worktrees.filter(w => w.status === 'active'),
	);

	$effect(() => {
		if (open) {
			title = '';
			description = '';
			sourceUrl = '';
			repo = repoPaths[0] ?? '';
			existingWorktreeId = eligibleWorktrees[0]?.id ?? '';
			mode = eligibleWorktrees.length === 0 ? 'new' : 'new';
			err = null;
		}
	});

	async function submit() {
		if (busy) return;
		err = null;
		const payload: Record<string, unknown> = {
			title: title.trim(),
			description: description.trim() || undefined,
			source_url: sourceUrl.trim() || undefined,
		};
		if (mode === 'existing') {
			if (!existingWorktreeId) { err = 'Pick an existing worktree'; return; }
			payload.worktree_id = existingWorktreeId;
		} else {
			if (!repo) { err = 'Pick a repo path'; return; }
			payload.new_worktree_repo = repo;
		}
		if (!title.trim()) { err = 'Title is required'; return; }

		busy = true;
		try {
			const res = await fetch('/api/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			// Wait briefly for the planning session to spin up before navigating.
			// The job poller dispatches in setTimeout(0) so the session_id is
			// usually populated within a second.
			const planningJobId = data.planning_job_id;
			invalidateAll();
			onclose();
			if (planningJobId) {
				const sessionId = await waitForSessionId(planningJobId);
				if (sessionId) goto(`/session/${sessionId}`);
			}
		} catch (e: any) {
			err = e.message ?? String(e);
		} finally {
			busy = false;
		}
	}

	async function waitForSessionId(jobId: string, timeoutMs = 15_000): Promise<string | null> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const res = await fetch(`/api/jobs/${jobId}`);
				if (res.ok) {
					const { job } = await res.json();
					if (job?.session_id) return job.session_id;
				}
			} catch {
				// ignore and retry
			}
			await new Promise(r => setTimeout(r, 750));
		}
		return null;
	}
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onclick={onclose} role="presentation">
		<div class="w-full max-w-lg bg-base-100 border border-base-300 p-6 shadow-xl" onclick={(e) => e.stopPropagation()} role="presentation">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold">New task</h2>
				<button class="btn btn-ghost btn-sm btn-square" onclick={onclose} aria-label="Close"><Icon name="close" class="w-4 h-4" /></button>
			</div>

			<div class="flex gap-2 mb-4 border border-base-300">
				<button
					class="flex-1 px-3 py-1.5 text-sm {mode === 'new' ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'}"
					onclick={() => mode = 'new'}
				>New worktree</button>
				<span class="w-px bg-base-300"></span>
				<button
					class="flex-1 px-3 py-1.5 text-sm {mode === 'existing' ? 'bg-base-content text-base-100 font-medium' : 'text-base-content-subtle'}"
					onclick={() => mode = 'existing'}
					disabled={eligibleWorktrees.length === 0}
				>Add to existing worktree</button>
			</div>

			<div class="flex flex-col gap-3">
				<label class="flex flex-col gap-1">
					<span class="text-xs uppercase tracking-wide text-base-content-faint">Title</span>
					<input class="input input-sm" placeholder="One-line task title" bind:value={title} />
				</label>

				<label class="flex flex-col gap-1">
					<span class="text-xs uppercase tracking-wide text-base-content-faint">Rough description (optional)</span>
					<textarea class="textarea textarea-sm" rows="3" placeholder="Anything to seed the planning chat" bind:value={description}></textarea>
				</label>

				<label class="flex flex-col gap-1">
					<span class="text-xs uppercase tracking-wide text-base-content-faint">Source URL (optional)</span>
					<input class="input input-sm" placeholder="GitHub issue or PR link" bind:value={sourceUrl} />
				</label>

				{#if mode === 'new'}
					<label class="flex flex-col gap-1">
						<span class="text-xs uppercase tracking-wide text-base-content-faint">Repo path</span>
						{#if repoPaths.length > 0}
							<select class="select select-sm" bind:value={repo}>
								{#each repoPaths as path}
									<option value={path}>{path}</option>
								{/each}
							</select>
						{:else}
							<input class="input input-sm" placeholder="/Users/jchan/code/foo" bind:value={repo} />
						{/if}
					</label>
				{:else}
					<label class="flex flex-col gap-1">
						<span class="text-xs uppercase tracking-wide text-base-content-faint">Worktree</span>
						<select class="select select-sm" bind:value={existingWorktreeId}>
							{#each eligibleWorktrees as w}
								<option value={w.id}>{w.slug} — {w.repo}</option>
							{/each}
						</select>
					</label>
				{/if}

				{#if err}
					<div class="text-xs text-error">{err}</div>
				{/if}

				<div class="flex justify-end gap-2 mt-2">
					<button class="btn btn-sm btn-ghost" onclick={onclose} disabled={busy}>Cancel</button>
					<button class="btn btn-sm btn-primary" onclick={submit} disabled={busy || !title.trim()}>
						{busy ? 'Creating…' : 'Create & start planning'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
