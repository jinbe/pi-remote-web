/**
 * POST   /api/push/subscribe — register or update a Web Push subscription.
 * DELETE /api/push/subscribe — remove by endpoint (body: { endpoint }).
 */
import { json, error } from '@sveltejs/kit';
import { upsertSubscription, deleteSubscription } from '$lib/server/push';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { endpoint, keys } = body ?? {};
		if (!endpoint || !keys?.p256dh || !keys?.auth) {
			throw error(400, 'subscription must include endpoint and keys.{p256dh,auth}');
		}
		const ua = request.headers.get('user-agent') ?? undefined;
		upsertSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, ua);
		return json({ ok: true });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, e.message ?? String(e));
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => null);
		const endpoint = body?.endpoint;
		if (!endpoint) throw error(400, 'endpoint is required');
		deleteSubscription(endpoint);
		return json({ ok: true });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, e.message ?? String(e));
	}
};
