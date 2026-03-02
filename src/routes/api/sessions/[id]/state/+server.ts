import { getState, isActive, getStreamingState } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ active: false });
	}
	try {
		const state = await getState(params.id);
		const local = getStreamingState(params.id);

		// Cross-check: if our server thinks we're streaming but pi's RPC
		// says it's not streaming AND there are no pending messages,
		// trust pi — the agent_end event was likely missed.
		// We don't mutate server state here (GET should be side-effect free);
		// the client uses this to decide whether to show streaming UI.
		const effectiveStreaming = local.isStreaming
			? (state.isStreaming || (state.pendingMessageCount ?? 0) > 0)
			: false;

		return json({ active: true, ...state, isStreaming: effectiveStreaming });
	} catch (e) {
		throw error(500, `Failed to get state: ${e}`);
	}
};
