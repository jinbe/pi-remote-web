import { json, error } from '@sveltejs/kit';
import { listPathSuggestions } from '$lib/server/path-autocomplete';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';

	try {
		const suggestions = listPathSuggestions(q);
		return json({ suggestions });
	} catch (e: any) {
		throw error(500, `Failed to list paths: ${e.message || e}`);
	}
};
