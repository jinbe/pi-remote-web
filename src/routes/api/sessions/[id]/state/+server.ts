import { getState, isActive, getStreamingState, resetStreaming } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ active: false });
	}
	try {
		const state = await getState(params.id);
		const local = getStreamingState(params.id);

		const effectiveStreaming = local.isStreaming
			? (state.isStreaming || (state.pendingMessageCount ?? 0) > 0)
			: false;

		// Fix server state if pi says not streaming but we think it is
		// This handles missed agent_end events
		if (local.isStreaming && !effectiveStreaming) {
			resetStreaming(params.id);
		}

		return json({ active: true, ...state, isStreaming: effectiveStreaming });
	} catch (e) {
		throw error(500, `Failed to get state: ${e}`);
	}
};
