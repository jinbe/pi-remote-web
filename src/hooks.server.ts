import { ensureInit } from '$lib/server/init';
import { setOrigin, getOrigin } from '$lib/server/origin';
import {
	isAuthEnabled,
	getTokenFromCookies,
	verifySessionToken,
} from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

const initPromise = ensureInit();

// Paths that bypass authentication:
// - /login — the login page itself
// - /api/auth/logout — the logout endpoint
// - /api/jobs/{id}/complete — job completion callbacks (own token auth)
function isPublicPath(pathname: string): boolean {
	if (pathname === '/login') return true;
	if (pathname === '/api/auth/logout') return true;
	if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/complete')) return true;
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	await initPromise;

	// Capture the server's origin from the first incoming request so that
	// background services (e.g. job-prompts) can build correct callback URLs
	// without relying on an environment variable.
	if (!getOrigin()) {
		setOrigin(event.url.origin);
	}

	// ---- Authentication gate ------------------------------------------------
	if (isAuthEnabled() && !isPublicPath(event.url.pathname)) {
		const token = getTokenFromCookies(event.request.headers.get('cookie'));
		const authenticated = token ? verifySessionToken(token) : false;

		// Store auth state so +page.server.ts / API routes can read it
		event.locals.authenticated = authenticated;

		if (!authenticated) {
			// API routes get a 401 JSON response
			if (event.url.pathname.startsWith('/api/')) {
				return new Response(JSON.stringify({ error: 'Unauthorised' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Page routes redirect to login
			const redirectTo = event.url.pathname + event.url.search;
			const loginUrl = '/login?redirect=' + encodeURIComponent(redirectTo);
			return new Response(null, {
				status: 303,
				headers: { Location: loginUrl },
			});
		}
	}

	return resolve(event);
};
