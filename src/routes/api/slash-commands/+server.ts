/**
 * GET /api/slash-commands — Return all discovered Claude Code slash commands.
 * POST /api/slash-commands — Force a rescan.
 */
import { json } from '@sveltejs/kit';
import { getSlashCommands, refreshSlashCommands } from '$lib/server/slash-commands';

export function GET() {
	return json({ commands: getSlashCommands() });
}

export function POST() {
	return json({ commands: refreshSlashCommands() });
}
