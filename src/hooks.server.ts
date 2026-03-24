import { ensureInit } from '$lib/server/init';
import { setOrigin, getOrigin } from '$lib/server/origin';
import type { Handle } from '@sveltejs/kit';

const initPromise = ensureInit();

export const handle: Handle = async ({ event, resolve }) => {
	await initPromise;

	// Capture the server's origin from the first incoming request so that
	// background services (e.g. job-prompts) can build correct callback URLs
	// without relying on an environment variable.
	if (!getOrigin()) {
		setOrigin(event.url.origin);
	}

	return resolve(event);
};
