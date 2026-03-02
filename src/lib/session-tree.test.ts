import { describe, it, expect } from 'bun:test';
import {
	buildSessionTree,
	getPathToNode,
	isAncestorOf,
	findLeafFrom,
	getBranchPoints
} from './session-tree';
import type { AgentMessage } from './types';

// --- Helpers ---

function makeMessage(
	id: string,
	parentId: string | null,
	role: 'user' | 'assistant' = 'user',
	text: string = `msg-${id}`
): AgentMessage {
	return {
		type: 'message',
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: 'text', text }]
		}
	};
}

function makeSession(cwd: string = '/test'): AgentMessage {
	return {
		type: 'session',
		id: 'session-0',
		parentId: null,
		timestamp: new Date().toISOString(),
		cwd
	};
}

// --- Tests ---

describe('buildSessionTree', () => {
	it('builds an empty tree from empty entries', () => {
		const tree = buildSessionTree([]);
		expect(tree.nodes).toEqual({});
		expect(tree.children).toEqual({});
		expect(tree.roots).toEqual([]);
		expect(tree.leaves).toEqual([]);
		expect(tree.currentLeaf).toBe('');
	});

	it('skips session-type entries', () => {
		const entries: AgentMessage[] = [makeSession(), makeMessage('1', null)];
		const tree = buildSessionTree(entries);
		expect(tree.nodes['session-0']).toBeUndefined();
		expect(tree.nodes['1']).toBeDefined();
		expect(tree.roots).toEqual(['1']);
	});

	it('builds a linear tree', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null, 'user', 'Hello'),
			makeMessage('2', '1', 'assistant', 'Hi'),
			makeMessage('3', '2', 'user', 'How are you?')
		];
		const tree = buildSessionTree(entries);

		expect(tree.roots).toEqual(['1']);
		expect(tree.children['1']).toEqual(['2']);
		expect(tree.children['2']).toEqual(['3']);
		expect(tree.leaves).toEqual(['3']);
		expect(tree.currentLeaf).toBe('3');
	});

	it('handles branching (multiple children for one parent)', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null, 'user'),
			makeMessage('2', '1', 'assistant'),
			makeMessage('3', '1', 'assistant') // branch from same parent
		];
		const tree = buildSessionTree(entries);

		expect(tree.children['1']).toEqual(['2', '3']);
		expect(tree.leaves).toContain('2');
		expect(tree.leaves).toContain('3');
		expect(tree.currentLeaf).toBe('3'); // last entry
	});

	it('identifies multiple roots', () => {
		const entries: AgentMessage[] = [makeMessage('1', null), makeMessage('2', null)];
		const tree = buildSessionTree(entries);
		expect(tree.roots).toEqual(['1', '2']);
	});

	it('currentLeaf is the last non-session entry', () => {
		const entries: AgentMessage[] = [
			makeSession(),
			makeMessage('a', null),
			makeMessage('b', 'a'),
			makeMessage('c', 'a') // branch
		];
		const tree = buildSessionTree(entries);
		expect(tree.currentLeaf).toBe('c');
	});
});

describe('getPathToNode', () => {
	it('returns empty array for nonexistent node', () => {
		const tree = buildSessionTree([]);
		expect(getPathToNode(tree, 'nonexistent')).toEqual([]);
	});

	it('returns empty array for empty nodeId', () => {
		const tree = buildSessionTree([]);
		expect(getPathToNode(tree, '')).toEqual([]);
	});

	it('returns single-element path for root node', () => {
		const entries = [makeMessage('1', null)];
		const tree = buildSessionTree(entries);
		const path = getPathToNode(tree, '1');
		expect(path.length).toBe(1);
		expect(path[0].id).toBe('1');
	});

	it('returns full path from root to leaf', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '2'),
			makeMessage('4', '3')
		];
		const tree = buildSessionTree(entries);
		const path = getPathToNode(tree, '4');
		expect(path.map((n) => n.id)).toEqual(['1', '2', '3', '4']);
	});

	it('returns correct path for a branching node', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '1'), // branch
			makeMessage('4', '3')
		];
		const tree = buildSessionTree(entries);
		const path = getPathToNode(tree, '4');
		expect(path.map((n) => n.id)).toEqual(['1', '3', '4']);
	});
});

describe('isAncestorOf', () => {
	const entries: AgentMessage[] = [
		makeMessage('1', null),
		makeMessage('2', '1'),
		makeMessage('3', '2'),
		makeMessage('4', '1') // branch
	];
	const tree = buildSessionTree(entries);

	it('returns true for direct parent', () => {
		expect(isAncestorOf(tree, '2', '3')).toBe(true);
	});

	it('returns true for grandparent', () => {
		expect(isAncestorOf(tree, '1', '3')).toBe(true);
	});

	it('returns true for self (node is its own ancestor)', () => {
		expect(isAncestorOf(tree, '2', '2')).toBe(true);
	});

	it('returns false for non-ancestor', () => {
		expect(isAncestorOf(tree, '3', '4')).toBe(false);
	});

	it('returns false for descendant-to-ancestor direction', () => {
		expect(isAncestorOf(tree, '3', '1')).toBe(false);
	});

	it('returns false for sibling nodes', () => {
		expect(isAncestorOf(tree, '2', '4')).toBe(false);
	});
});

describe('findLeafFrom', () => {
	it('returns the node itself if it is a leaf', () => {
		const entries = [makeMessage('1', null)];
		const tree = buildSessionTree(entries);
		expect(findLeafFrom(tree, '1')).toBe('1');
	});

	it('follows first child to find leaf in linear chain', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '2')
		];
		const tree = buildSessionTree(entries);
		expect(findLeafFrom(tree, '1')).toBe('3');
	});

	it('follows first child at each branch point', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '1'), // second child of 1
			makeMessage('4', '2')
		];
		const tree = buildSessionTree(entries);
		// First child of '1' is '2', leaf from '2' is '4'
		expect(findLeafFrom(tree, '1')).toBe('4');
	});

	it('returns starting node leaf when starting mid-tree', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '2'),
			makeMessage('4', '2') // branch from 2
		];
		const tree = buildSessionTree(entries);
		// First child of '2' is '3'
		expect(findLeafFrom(tree, '2')).toBe('3');
	});
});

describe('getBranchPoints', () => {
	it('returns empty map for linear tree', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '2')
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);
		expect(bp.size).toBe(0);
	});

	it('detects branch point with multiple children', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null, 'user', 'Root message here'),
			makeMessage('2', '1', 'assistant', 'Branch A'),
			makeMessage('3', '1', 'assistant', 'Branch B')
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);

		expect(bp.size).toBe(1);
		expect(bp.has('1')).toBe(true);

		const point = bp.get('1')!;
		expect(point.nodeId).toBe('1');
		expect(point.message).toBe('Root message here');
		expect(point.branches.length).toBe(2);
	});

	it('calculates branch message counts correctly', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '2'), // branch 1: 2 -> 3 -> 4
			makeMessage('4', '3'),
			makeMessage('5', '1') // branch 2: 5 (only 1 message deep)
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);

		expect(bp.has('1')).toBe(true);
		const point = bp.get('1')!;

		// Branch starting at '2' goes 2 -> 3 -> 4 = 3 messages
		const branchA = point.branches.find((b) => b.childId === '2')!;
		expect(branchA.messageCount).toBe(3);

		// Branch starting at '5' has just 1 message
		const branchB = point.branches.find((b) => b.childId === '5')!;
		expect(branchB.messageCount).toBe(1);
	});

	it('marks current path correctly', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '1') // currentLeaf will be '3' (last entry)
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);

		const point = bp.get('1')!;
		const branchA = point.branches.find((b) => b.childId === '2')!;
		const branchB = point.branches.find((b) => b.childId === '3')!;

		expect(branchA.isCurrentPath).toBe(false);
		expect(branchB.isCurrentPath).toBe(true); // '3' is current leaf
	});

	it('extracts preview text from branch children', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null, 'user', 'root'),
			makeMessage('2', '1', 'assistant', 'First branch response'),
			makeMessage('3', '1', 'assistant', 'Second branch response')
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);

		const point = bp.get('1')!;
		const previews = point.branches.map((b) => b.preview);
		expect(previews).toContain('First branch response');
		expect(previews).toContain('Second branch response');
	});

	it('handles multiple branch points in same tree', () => {
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1'),
			makeMessage('3', '1'), // branch point at '1'
			makeMessage('4', '2'),
			makeMessage('5', '2') // branch point at '2'
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);

		expect(bp.size).toBe(2);
		expect(bp.has('1')).toBe(true);
		expect(bp.has('2')).toBe(true);
	});

	it('truncates message to 100 chars', () => {
		const longText = 'a'.repeat(200);
		const entries: AgentMessage[] = [
			makeMessage('1', null, 'user', longText),
			makeMessage('2', '1'),
			makeMessage('3', '1')
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);
		const point = bp.get('1')!;
		expect(point.message.length).toBe(100);
	});

	it('truncates preview to 80 chars', () => {
		const longText = 'b'.repeat(200);
		const entries: AgentMessage[] = [
			makeMessage('1', null),
			makeMessage('2', '1', 'assistant', longText),
			makeMessage('3', '1')
		];
		const tree = buildSessionTree(entries);
		const bp = getBranchPoints(tree);
		const point = bp.get('1')!;
		const branch = point.branches.find((b) => b.childId === '2')!;
		expect(branch.preview.length).toBe(80);
	});
});
