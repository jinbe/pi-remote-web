import { decodeSessionId, getSessionMessages } from '$lib/server/session-scanner';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const filePath = decodeSessionId(params.id);
	try {
		const { messages, tree } = await getSessionMessages(filePath);
		return json({ messages, tree });
	} catch (e) {
		throw error(500, `Failed to load messages: ${e}`);
	}
};
