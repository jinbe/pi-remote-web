/**
 * GET /api/push/vapid-key — public VAPID key for browser subscription.
 */
import { json } from '@sveltejs/kit';
import { getVapidPublicKey } from '$lib/server/push';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ publicKey: getVapidPublicKey() });
};
