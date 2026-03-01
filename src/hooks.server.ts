import { ensureInit } from '$lib/server/init';
import type { Handle } from '@sveltejs/kit';

const initPromise = ensureInit();

export const handle: Handle = async ({ event, resolve }) => {
	await initPromise;
	return resolve(event);
};
