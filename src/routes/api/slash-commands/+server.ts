/**
 * GET /api/slash-commands — Return all discovered Claude Code slash commands.
 * POST /api/slash-commands — Force a rescan.
 *
 * Both accept an optional `?sessionId=...` query parameter. When provided,
 * the session's working directory is resolved so project-level skills
 * (`.claude/skills/` relative to cwd) are included in the results.
 */
import { json } from '@sveltejs/kit';
import { getSlashCommands, refreshSlashCommands } from '$lib/server/slash-commands';
import { getActiveSession } from '$lib/server/rpc-manager';
import type { RequestHandler } from './$types';

/** Resolve the project directory from an optional sessionId query param. */
function resolveProjectDir(url: URL): string | undefined {
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) return undefined;

	const session = getActiveSession(sessionId);
	return session?.cwd || undefined;
}

export const GET: RequestHandler = ({ url }) => {
	const projectDir = resolveProjectDir(url);
	return json({ commands: getSlashCommands({ projectDir }) });
};

export const POST: RequestHandler = ({ url }) => {
	const projectDir = resolveProjectDir(url);
	return json({ commands: refreshSlashCommands({ projectDir }) });
};
