import { createSession, type HarnessType } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { model, harness } = body as { cwd: string; model?: string; harness?: HarnessType };
		const cwd = resolve(body.cwd || '');

		if (!cwd || !existsSync(cwd)) throw error(400, 'Invalid or non-existent working directory');

		const sessionId = await createSession(cwd, model, harness);
		return json({ ok: true, sessionId });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to create session: ${e.message || e}`);
	}
};
