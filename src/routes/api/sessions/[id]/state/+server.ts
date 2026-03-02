import { getState, isActive, isStreaming } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!isActive(params.id)) {
		return json({ active: false });
	}
	try {
		const state = await getState(params.id);
		// Use server-tracked isStreaming (agent_start→agent_end) instead of
		// the RPC get_state isStreaming which only reflects LLM token generation.
		// Between turns (tool execution → next LLM call), the RPC reports
		// isStreaming:false even though the agent is still processing.
		return json({ active: true, ...state, isStreaming: isStreaming(params.id) });
	} catch (e) {
		throw error(500, `Failed to get state: ${e}`);
	}
};
