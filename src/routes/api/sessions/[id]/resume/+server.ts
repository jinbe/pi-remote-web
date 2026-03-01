import { resumeSession } from '$lib/server/rpc-manager';
import { decodeSessionId, parseSessionMetadata } from '$lib/server/session-scanner';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	const filePath = decodeSessionId(params.id);

	try {
		const meta = await parseSessionMetadata(filePath);
		await resumeSession(params.id, filePath, meta.cwd);
		return json({ ok: true });
	} catch (e) {
		throw error(500, `Failed to resume session: ${e}`);
	}
};
