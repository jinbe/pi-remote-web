import { createSession } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { cwd, model } = body as { cwd: string; model?: string };

		if (!cwd) throw error(400, 'cwd is required');

		const sessionId = await createSession(cwd, model);
		return json({ ok: true, sessionId });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to create session: ${e.message || e}`);
	}
};
