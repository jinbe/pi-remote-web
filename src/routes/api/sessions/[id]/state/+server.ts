import { getState, isActive, isStreaming, resetStreaming } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ active: false });
	}
	try {
		const state = await getState(params.id);
		const serverStreaming = isStreaming(params.id);
		const rpcStreaming = state.isStreaming ?? false;
		// Server tracks agent_start→agent_end for the full agent turn.
		// RPC get_state.isStreaming reflects the actual pi agent state.
		// If our server thinks we're streaming but pi says it's not,
		// the agent_end event was missed — reset our tracking.
		if (serverStreaming && !rpcStreaming && state.pendingMessageCount === 0) {
			resetStreaming(params.id);
		}
		const effectiveStreaming = serverStreaming && rpcStreaming;
		return json({ active: true, ...state, isStreaming: effectiveStreaming });
	} catch (e) {
		throw error(500, `Failed to get state: ${e}`);
	}
};
