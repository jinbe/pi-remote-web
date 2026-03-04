<script lang="ts">
	import type { BranchPoint } from '$lib/types';
	import { hapticLight } from '$lib/haptics';

	let {
		branchPoint,
		onselect
	}: {
		branchPoint: BranchPoint;
		onselect: (childId: string) => void;
	} = $props();

	function selectBranch(childId: string) {
		hapticLight();
		onselect(childId);
	}
</script>

<div class="my-2 flex items-center gap-2">
	<div class="dropdown">
		<div tabindex="0" role="button" class="badge badge-outline badge-sm cursor-pointer gap-1" aria-label="Switch branch">
			🔀 {branchPoint.branches.length} branches
		</div>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<ul tabindex="0" class="dropdown-content menu bg-base-200 rounded-box z-10 w-72 p-2 shadow-lg">
			{#each branchPoint.branches as branch}
				<li>
					<button
						class="text-left {branch.isCurrentPath ? 'active' : ''}"
						onclick={() => selectBranch(branch.childId)}
					>
						<div class="flex flex-col">
							<span class="text-xs font-medium">
								{branch.isCurrentPath ? '▸ Current' : '▸ Alt'}
								<span class="text-base-content-faint">({branch.messageCount} msgs)</span>
							</span>
							{#if branch.preview}
								<span class="text-xs text-base-content-muted truncate">
									"{branch.preview}"
								</span>
							{/if}
						</div>
					</button>
				</li>
			{/each}
		</ul>
	</div>
</div>
