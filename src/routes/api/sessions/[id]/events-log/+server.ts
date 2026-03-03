import { getSessionEvents } from '$lib/server/cache';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const events = getSessionEvents(params.id);
	return json({ events });
};
