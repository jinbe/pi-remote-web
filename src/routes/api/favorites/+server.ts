import { getFavoriteProjects, addFavoriteProject, removeFavoriteProject } from '$lib/server/cache';
import { json, error } from '@sveltejs/kit';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	return json([...getFavoriteProjects()]);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { cwd: string; action: 'add' | 'remove' };
	const cwd = resolve(body.cwd || '');

	if (!cwd || !existsSync(cwd)) {
		throw error(400, 'Invalid or non-existent working directory');
	}

	if (body.action === 'add') {
		addFavoriteProject(cwd);
	} else {
		removeFavoriteProject(cwd);
	}
	return json({ ok: true });
};
