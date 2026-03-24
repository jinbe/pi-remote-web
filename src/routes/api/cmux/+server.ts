/**
 * cmux-compatible API for pi-remote-web
 *
 * Provides a REST API that mirrors the core cmux tool interface,
 * allowing agents (pi sessions) to orchestrate other pi sessions.
 *
 * Supported operations:
 *   - split    → spawn a new pi session (like cmux_split)
 *   - send     → send text/key to a session (like cmux_send)
 *   - read     → read recent output from a session (like cmux_read)
 *   - close    → stop a session (like cmux_close)
 *   - list     → list active sessions (like cmux_list)
 *   - notify   → log a notification (like cmux_notify)
 *
 * Limitations:
 *   - All agents are pi (no claude code / other agent support)
 *   - No browser QA support
 *   - "key" sends are limited (enter mapped to follow_up trigger)
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	handleSplit,
	handleSend,
	handleRead,
	handleClose,
	handleList,
	handleNotify,
} from '$lib/server/cmux-manager';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { action } = body as { action: string };

		if (!action) throw error(400, 'Missing "action" field');

		switch (action) {
			case 'split':
				return json(await handleSplit(body));
			case 'send':
				return json(await handleSend(body));
			case 'read':
				return json(await handleRead(body));
			case 'close':
				return json(await handleClose(body));
			case 'list':
				return json(await handleList());
			case 'notify':
				return json(await handleNotify(body));
			default:
				throw error(400, `Unknown action: ${action}`);
		}
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `cmux API error: ${e.message || e}`);
	}
};
