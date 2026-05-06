<script lang="ts">
	import { invalidateAll, goto } from '$app/navigation';
	import { timeAgo, shortenHome } from '$lib/utils';
	import { hapticLight, hapticMedium, hapticHeavy } from '$lib/haptics';
	import Icon from '$lib/components/Icon.svelte';
	import StatusDot from '$lib/components/StatusDot.svelte';
	import AddTaskModal from '$lib/components/AddTaskModal.svelte';
	import PiWordmark from '$lib/components/PiWordmark.svelte';
	import { enablePush, disablePush, getPushState, type PushState } from '$lib/push-client';
	import { getContext, onMount } from 'svelte';

	interface Worktree {
		id: string;
		repo: string;
		dir_path: string;
		base_branch: string;
		slug: string;
		status: 'active' | 'paused' | 'halted' | 'closed';
		halt_reason: string | null;
		external_loop_cap: number;
		internal_loop_cap: number;
		created_at: string;
		closed_at: string | null;
		last_activity_at: string;
	}

	interface Task {
		id: string;
		worktree_id: string;
		title: string;
		description: string | null;
		position: number;
		stage: string;
		current_pr_url: string | null;
		current_pr_number: number | null;
		branch: string | null;
		current_session_id: string | null;
		current_job_id: string | null;
		internal_loop_count: number;
		external_loop_count: number;
		triage_plan_json: string | null;
		error: string | null;
		created_at: string;
		completed_at: string | null;
	}

	let { data } = $props();
	const { theme, toggleTheme } = getContext<{ theme: 'dark' | 'light'; toggleTheme: () => void }>('theme');

	let showAdd = $state(false);
	let pushState = $state<PushState>('unsupported');
	let pushBusy = $state(false);
	let acceptingTaskId = $state<string | null>(null);
	let acceptDescription = $state('');
	let acceptBusy = $state(false);
	let acceptErr = $state<string | null>(null);

	const tasksByWorktree = $derived.by(() => {
		const map = new Map<string, Task[]>();
		for (const t of (data.tasks as Task[])) {
			const arr = map.get(t.worktree_id) ?? [];
			arr.push(t);
			map.set(t.worktree_id, arr);
		}
		for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
		return map;
	});

	const visibleWorktrees = $derived(
		(data.worktrees as Worktree[]).filter(w => w.status !== 'closed'),
	);

	function stageBadge(stage: string): { label: string; cls: string } {
		switch (stage) {
			case 'planning':         return { label: 'planning',         cls: 'bg-info/15 text-info' };
			case 'queued':           return { label: 'queued',           cls: 'bg-base-300 text-base-content' };
			case 'dev':              return { label: 'dev',              cls: 'bg-warning/15 text-warning' };
			case 'internal_review':  return { label: 'internal review',  cls: 'bg-secondary/15 text-secondary' };
			case 'external_review':  return { label: 'external review',  cls: 'bg-accent/15 text-accent' };
			case 'awaiting_merge':   return { label: 'ready to merge',   cls: 'bg-success/15 text-success' };
			case 'done':             return { label: 'merged',           cls: 'bg-success/10 text-success/70' };
			case 'failed':           return { label: 'failed',           cls: 'bg-error/15 text-error' };
			case 'cancelled':        return { label: 'cancelled',        cls: 'bg-base-200 text-base-content-faint' };
			default:                 return { label: stage,              cls: 'bg-base-200 text-base-content-faint' };
		}
	}

	function statusBadge(status: string): { label: string; cls: string } {
		switch (status) {
			case 'active': return { label: 'active', cls: 'bg-success/15 text-success' };
			case 'halted': return { label: 'halted', cls: 'bg-error/20 text-error' };
			case 'paused': return { label: 'paused', cls: 'bg-warning/15 text-warning' };
			case 'closed': return { label: 'closed', cls: 'bg-base-300 text-base-content-faint' };
			default:       return { label: status,   cls: 'bg-base-200 text-base-content-faint' };
		}
	}

	async function openPlanning(task: Task) {
		hapticLight();
		if (task.current_session_id) {
			goto(`/session/${task.current_session_id}`);
		}
	}

	async function startAcceptPlan(task: Task) {
		hapticMedium();
		acceptingTaskId = task.id;
		acceptDescription = task.description ?? '';
		acceptErr = null;
	}

	async function submitAcceptPlan() {
		if (!acceptingTaskId) return;
		acceptBusy = true;
		acceptErr = null;
		try {
			const res = await fetch(`/api/tasks/${acceptingTaskId}/accept-plan`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ description: acceptDescription }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.message ?? `HTTP ${res.status}`);
			}
			acceptingTaskId = null;
			acceptDescription = '';
			invalidateAll();
		} catch (e: any) {
			acceptErr = e.message ?? String(e);
		} finally {
			acceptBusy = false;
		}
	}

	async function cancelTask(task: Task) {
		if (!confirm(`Cancel task "${task.title}"? The worktree's queue will advance past it.`)) return;
		hapticHeavy();
		await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
		invalidateAll();
	}

	async function resumeWt(wt: Worktree) {
		hapticMedium();
		await fetch(`/api/worktrees/${wt.id}/resume`, { method: 'POST' });
		invalidateAll();
	}

	async function closeWt(wt: Worktree) {
		const tasks = tasksByWorktree.get(wt.id) ?? [];
		const active = tasks.filter(t => !['done', 'failed', 'cancelled'].includes(t.stage)).length;
		const force = active > 0;
		const msg = force
			? `Close worktree "${wt.slug}"? ${active} task(s) are still active and will be force-closed.`
			: `Close worktree "${wt.slug}"?`;
		if (!confirm(msg)) return;
		hapticHeavy();
		await fetch(`/api/worktrees/${wt.id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
		invalidateAll();
	}

	onMount(async () => {
		pushState = await getPushState();
	});

	async function togglePush() {
		if (pushBusy) return;
		pushBusy = true;
		try {
			if (pushState === 'subscribed') {
				await disablePush();
			} else {
				await enablePush();
			}
			pushState = await getPushState();
		} finally {
			pushBusy = false;
		}
	}

	// Auto-refresh on session/job events.
	$effect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const es = new EventSource('/api/sessions/watch');
		es.onmessage = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => { timer = null; invalidateAll(); }, 500);
		};
		return () => { es.close(); if (timer) clearTimeout(timer); };
	});
</script>

<div class="mx-auto max-w-5xl px-4 sm:px-6 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] h-full overflow-y-auto">
	<header class="mb-4 flex items-center justify-between gap-4">
		<div class="flex items-center gap-4">
			<a href="/"><PiWordmark height={22} /></a>
			<span class="hidden sm:inline-block w-px h-4 bg-base-300"></span>
			<span class="text-[15px] font-medium">Worktrees</span>
		</div>
		<div class="flex gap-2 items-center">
			<a href="/jobs" class="btn btn-sm btn-ghost gap-1">
				<Icon name="hammer" class="w-4 h-4" />
				<span class="hidden sm:inline">Jobs</span>
			</a>
			{#if pushState !== 'unsupported' && pushState !== 'denied'}
				<button
					class="btn btn-sm btn-ghost gap-1"
					onclick={togglePush}
					disabled={pushBusy}
					title={pushState === 'subscribed' ? 'Disable notifications' : 'Enable notifications'}
				>
					<Icon name={pushState === 'subscribed' ? 'bell' : 'bell-off'} class="w-4 h-4" />
					<span class="hidden sm:inline">{pushState === 'subscribed' ? 'On' : 'Off'}</span>
				</button>
			{/if}
			<button class="btn btn-sm btn-primary gap-1" onclick={() => { hapticMedium(); showAdd = true; }}>
				<Icon name="plus" class="w-4 h-4" />
				<span class="hidden sm:inline">New task</span>
				<span class="sm:hidden">New</span>
			</button>
			<button class="btn btn-sm btn-ghost btn-square" onclick={() => { hapticLight(); toggleTheme(); }} aria-label="Toggle theme">
				{#if theme === 'dark'}<Icon name="sun" class="w-4 h-4" />{:else}<Icon name="moon" class="w-4 h-4" />{/if}
			</button>
		</div>
	</header>

	{#if visibleWorktrees.length === 0}
		<div class="py-12 text-center text-base-content-subtle">
			<p class="text-lg">No worktrees yet</p>
			<p class="text-sm mb-4">Create your first task to spin one up.</p>
			<button class="btn btn-primary btn-sm" onclick={() => showAdd = true}>
				<Icon name="plus" class="w-4 h-4" /> New task
			</button>
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			{#each visibleWorktrees as wt (wt.id)}
				{@const tasks = tasksByWorktree.get(wt.id) ?? []}
				{@const status = statusBadge(wt.status)}
				<article class="border border-base-300 bg-base-100">
					<header class="flex items-center gap-3 px-4 py-3 border-b border-base-300 bg-base-200/30">
						<div class="flex-1 min-w-0">
							<div class="flex items-baseline gap-2">
								<span class="font-medium text-[15px] truncate">{wt.slug}</span>
								<span class="text-[11px] uppercase tracking-wider px-1.5 py-0.5 leading-none {status.cls}">{status.label}</span>
							</div>
							<div class="mt-0.5 text-[11.5px] text-base-content-subtle font-mono truncate">
								{shortenHome(wt.repo)} · {wt.base_branch} · last activity {timeAgo(wt.last_activity_at)}
							</div>
							{#if wt.halt_reason}
								<div class="mt-1 text-[12px] text-error">⚠ {wt.halt_reason}</div>
							{/if}
						</div>
						<div class="flex items-center gap-1">
							{#if wt.status === 'halted'}
								<button class="btn btn-xs btn-outline border-success text-success" onclick={() => resumeWt(wt)}>
									Resume
								</button>
							{/if}
							<button class="btn btn-xs btn-ghost text-error" onclick={() => closeWt(wt)} title="Close worktree">
								<Icon name="trash" class="w-3.5 h-3.5" />
							</button>
						</div>
					</header>

					{#if tasks.length === 0}
						<div class="px-4 py-6 text-center text-sm text-base-content-faint">
							No tasks yet.
						</div>
					{:else}
						<ul class="divide-y divide-base-300">
							{#each tasks as task (task.id)}
								{@const stage = stageBadge(task.stage)}
								<li class="px-4 py-3 flex items-center gap-3">
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-xs text-base-content-faint font-mono w-6 text-right">#{task.position}</span>
											<span class="text-[14px] font-medium truncate">{task.title}</span>
											<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 leading-none {stage.cls}">{stage.label}</span>
										</div>
										<div class="mt-0.5 text-[11.5px] text-base-content-subtle truncate flex items-center gap-3">
											{#if task.branch}<span class="font-mono">{task.branch}</span>{/if}
											{#if task.current_pr_url}
												<a class="link" href={task.current_pr_url} target="_blank" rel="noopener noreferrer">PR #{task.current_pr_number}</a>
											{/if}
											{#if task.internal_loop_count > 0}<span>internal loops: {task.internal_loop_count}</span>{/if}
											{#if task.external_loop_count > 0}<span>external loops: {task.external_loop_count}</span>{/if}
										</div>
										{#if task.error}
											<div class="mt-1 text-[12px] text-error">{task.error}</div>
										{/if}
										{#if task.stage === 'awaiting_merge' && task.triage_plan_json}
											<details class="mt-2">
												<summary class="text-[11.5px] text-base-content-subtle cursor-pointer">Triage plan</summary>
												<pre class="text-[11px] mt-1 p-2 bg-base-200 overflow-x-auto">{task.triage_plan_json}</pre>
											</details>
										{/if}
									</div>
									<div class="flex items-center gap-1">
										{#if task.stage === 'planning'}
											{#if task.current_session_id}
												<button class="btn btn-xs btn-ghost" onclick={() => openPlanning(task)} title="Open planning chat">
													<Icon name="chevron-right" class="w-3.5 h-3.5" /> Chat
												</button>
											{/if}
											<button class="btn btn-xs btn-primary" onclick={() => startAcceptPlan(task)}>
												Accept plan
											</button>
										{/if}
										{#if !['done', 'failed', 'cancelled', 'awaiting_merge'].includes(task.stage)}
											<button class="btn btn-xs btn-ghost text-error" onclick={() => cancelTask(task)} title="Cancel task">
												<Icon name="close" class="w-3.5 h-3.5" />
											</button>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>

{#if acceptingTaskId}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onclick={() => acceptingTaskId = null}>
		<div class="w-full max-w-2xl bg-base-100 border border-base-300 p-6" role="presentation" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold">Accept plan</h2>
				<button class="btn btn-ghost btn-sm btn-square" onclick={() => acceptingTaskId = null} aria-label="Close"><Icon name="close" class="w-4 h-4" /></button>
			</div>
			<p class="text-sm text-base-content-subtle mb-2">
				This becomes the dev agent's full spec. Edit before accepting.
			</p>
			<textarea class="textarea w-full min-h-[300px] text-sm font-mono" bind:value={acceptDescription}></textarea>
			{#if acceptErr}
				<div class="mt-2 text-xs text-error">{acceptErr}</div>
			{/if}
			<div class="flex justify-end gap-2 mt-4">
				<button class="btn btn-sm btn-ghost" onclick={() => acceptingTaskId = null} disabled={acceptBusy}>Cancel</button>
				<button class="btn btn-sm btn-primary" onclick={submitAcceptPlan} disabled={acceptBusy || !acceptDescription.trim()}>
					{acceptBusy ? 'Accepting…' : 'Accept & queue dev'}
				</button>
			</div>
		</div>
	</div>
{/if}

<AddTaskModal
	open={showAdd}
	repoPaths={data.repoPaths}
	worktrees={data.worktrees as any}
	onclose={() => { showAdd = false; invalidateAll(); }}
/>
