/**
 * POST /api/auth/logout — Clear the auth session cookie.
 */
import { redirect } from '@sveltejs/kit';
import { COOKIE_NAME } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete(COOKIE_NAME, { path: '/' });
	throw redirect(303, '/login');
};
