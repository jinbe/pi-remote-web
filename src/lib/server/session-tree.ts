// Re-export shared tree logic — server modules import from here for convenience
export { buildSessionTree, getPathToNode, getBranchPoints, isAncestorOf, findLeafFrom } from '$lib/session-tree';
