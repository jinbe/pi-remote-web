import {
	decodeSessionId,
	parseSessionMetadata
} from '$lib/server/session-scanner';
import { isActive, getActiveSession } from '$lib/server/rpc-manager';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const filePath = decodeSessionId(params.id);
	const active = isActive(params.id);

	// Try loading metadata from the JSONL file
	try {
		const meta = await parseSessionMetadata(filePath);
		return {
			sessionId: params.id,
			filePath,
			meta: {
				...meta,
				lastModified: meta.lastModified.toISOString()
			},
			isActive: active
		};
	} catch {
		// File may not be ready yet for newly created sessions
	}

	// Fallback for active sessions whose file isn't scannable yet
	if (active) {
		const info = getActiveSession(params.id);
		return {
			sessionId: params.id,
			filePath,
			meta: {
				id: params.id,
				filePath,
				cwd: info?.cwd ?? '',
				name: null,
				firstMessage: '(new session)',
				lastModified: new Date().toISOString(),
				messageCount: 0,
				model: info?.model ?? null
			},
			isActive: true
		};
	}

	throw error(404, 'Session not found');
};
