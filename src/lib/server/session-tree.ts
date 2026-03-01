import type { AgentMessage, SessionTree, BranchPoint, Branch } from '$lib/types';

export function buildSessionTree(entries: AgentMessage[]): SessionTree {
	const nodes: Record<string, AgentMessage> = {};
	const children: Record<string, string[]> = {};
	const roots: string[] = [];
	let lastEntryId = '';

	for (const entry of entries) {
		// Skip session header — metadata only, not a tree node
		if (entry.type === 'session') continue;

		nodes[entry.id] = entry;
		lastEntryId = entry.id;

		if (entry.parentId === null || entry.parentId === undefined) {
			roots.push(entry.id);
		} else {
			if (!children[entry.parentId]) {
				children[entry.parentId] = [];
			}
			children[entry.parentId].push(entry.id);
		}
	}

	// Find leaves (nodes with no children)
	const leaves: string[] = [];
	for (const id of Object.keys(nodes)) {
		if (!children[id] || children[id].length === 0) {
			leaves.push(id);
		}
	}

	return {
		nodes,
		children,
		roots,
		leaves,
		currentLeaf: lastEntryId
	};
}

export function getPathToNode(tree: SessionTree, nodeId: string): AgentMessage[] {
	if (!nodeId || !tree.nodes[nodeId]) return [];

	const path: AgentMessage[] = [];
	let current: string | undefined | null = nodeId;

	while (current && tree.nodes[current]) {
		path.unshift(tree.nodes[current]);
		current = tree.nodes[current].parentId;
	}

	return path;
}

export function getBranchPoints(tree: SessionTree): BranchPoint[] {
	const points: BranchPoint[] = [];

	for (const [parentId, childIds] of Object.entries(tree.children)) {
		if (childIds.length <= 1) continue;

		const parentNode = tree.nodes[parentId];
		if (!parentNode) continue;

		let message = '';
		if (parentNode.type === 'message' && parentNode.message?.content) {
			const textContent = parentNode.message.content.find((c: any) => c.type === 'text');
			message = textContent?.text?.slice(0, 100) || '';
		}

		const branches: Branch[] = childIds.map((childId) => {
			const child = tree.nodes[childId];
			let preview = '';
			if (child?.type === 'message' && child.message?.content) {
				const tc = child.message.content.find((c: any) => c.type === 'text');
				preview = tc?.text?.slice(0, 80) || '';
			}

			// Count depth of this branch
			let count = 0;
			let cur: string | null = childId;
			while (cur && tree.nodes[cur]) {
				count++;
				const kids: string[] | undefined = tree.children[cur];
				cur = kids && kids.length > 0 ? kids[0] : null;
			}

			// Check if this branch leads to currentLeaf
			const isCurrentPath = isAncestorOf(tree, childId, tree.currentLeaf);

			return { childId, preview, messageCount: count, isCurrentPath };
		});

		points.push({ nodeId: parentId, message, branches });
	}

	return points;
}

function isAncestorOf(tree: SessionTree, ancestorId: string, descendantId: string): boolean {
	let cur: string | undefined | null = descendantId;
	while (cur) {
		if (cur === ancestorId) return true;
		cur = tree.nodes[cur]?.parentId;
	}
	return false;
}
