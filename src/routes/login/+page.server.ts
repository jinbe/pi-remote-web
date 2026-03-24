import { redirect, fail } from '@sveltejs/kit';
import {
	isAuthEnabled,
	verifyPassword,
	createSessionToken,
	COOKIE_NAME,
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const load: PageServerLoad = async ({ url }) => {
	// If auth is not enabled, redirect straight to the dashboard
	if (!isAuthEnabled()) {
		throw redirect(303, '/');
	}

	return {
		redirect: url.searchParams.get('redirect') ?? '/',
	};
};

export const actions: Actions = {
	default: async ({ request, url, cookies }) => {
		if (!isAuthEnabled()) {
			throw redirect(303, '/');
		}

		const formData = await request.formData();
		const password = formData.get('password');
		const redirectTo =
			formData.get('redirect')?.toString() ||
			url.searchParams.get('redirect') ||
			'/';

		if (!password || typeof password !== 'string') {
			return fail(400, { error: 'Password is required', redirect: redirectTo });
		}

		const valid = await verifyPassword(password);
		if (!valid) {
			return fail(401, { error: 'Invalid password', redirect: redirectTo });
		}

		const token = createSessionToken();
		const secure = url.protocol === 'https:';

		cookies.set(COOKIE_NAME, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure,
			maxAge: COOKIE_MAX_AGE_SECONDS,
		});

		throw redirect(303, redirectTo);
	},
};
