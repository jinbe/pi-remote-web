import { decodeSessionId, getTailMessages } from '$lib/server/session-scanner';
import { existsSync } from 'fs';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const filePath = decodeSessionId(params.id);
	const count = Math.max(1, Math.min(200, parseInt(url.searchParams.get('count') || '20') || 20));

	if (!existsSync(filePath)) {
		return json({ messages: [], hasMore: false });
	}

	try {
		// Works for both pi and Claude Code sessions (auto-detected internally)
		const result = await getTailMessages(filePath, count);
		return json(result);
	} catch (e) {
		throw error(500, `Failed to load tail messages: ${e}`);
	}
};
