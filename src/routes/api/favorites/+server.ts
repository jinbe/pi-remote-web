import { getFavoriteProjects, addFavoriteProject, removeFavoriteProject } from '$lib/server/cache';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	return json([...getFavoriteProjects()]);
};

export const POST: RequestHandler = async ({ request }) => {
	const { cwd, action } = (await request.json()) as { cwd: string; action: 'add' | 'remove' };
	if (action === 'add') {
		addFavoriteProject(cwd);
	} else {
		removeFavoriteProject(cwd);
	}
	return json({ ok: true });
};
