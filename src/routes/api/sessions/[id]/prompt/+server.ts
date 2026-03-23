import { sendMessage } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const body = await request.json();
		const { message, behavior, images } = body as {
			message: string;
			behavior?: 'steer' | 'followUp';
			images?: Array<{ type: 'image'; data: string; mimeType: string }>;
		};

		if (!message) throw error(400, 'Message is required');

		const result = await sendMessage(params.id, message, behavior, images);
		return json({ ok: true, result });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to send message: ${e.message || e}`);
	}
};
