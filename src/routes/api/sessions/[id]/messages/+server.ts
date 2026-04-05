import { decodeSessionId, getSessionMessages } from '$lib/server/session-scanner';
import { existsSync } from 'fs';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const filePath = decodeSessionId(params.id);

	// For Claude Code sessions, the file may not exist (synthetic path from relay)
	if (!existsSync(filePath)) {
		return json({ messages: [], tree: { entries: [], currentLeaf: '' } });
	}

	try {
		const { messages, tree } = await getSessionMessages(filePath);
		return json({ messages, tree });
	} catch (e) {
		throw error(500, `Failed to load messages: ${e}`);
	}
};
