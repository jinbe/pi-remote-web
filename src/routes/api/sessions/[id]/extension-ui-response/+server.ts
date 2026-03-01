import { sendExtensionUIResponse } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		await sendExtensionUIResponse(params.id, body);
		return json({ ok: true });
	} catch (e) {
		throw error(500, `Failed to send extension UI response: ${e}`);
	}
};
