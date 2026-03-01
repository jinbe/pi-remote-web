import { getDevCommand, setDevCommand, getAllDevCommands } from '$lib/server/cache';
import { startDevServer, stopDevServer, isDevServerRunning, getRunningDevServerCwds } from '$lib/server/dev-server-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// GET: return dev server status for all projects
export const GET: RequestHandler = () => {
	const commands = Object.fromEntries(getAllDevCommands());
	const running = getRunningDevServerCwds();
	return json({ commands, running });
};

// POST: start, stop, or configure dev server
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json() as {
		action: 'start' | 'stop' | 'configure';
		cwd: string;
		command?: string;
	};

	const { action, cwd } = body;

	if (action === 'configure') {
		setDevCommand(cwd, body.command ?? null);
		return json({ ok: true });
	}

	if (action === 'start') {
		const command = body.command ?? getDevCommand(cwd);
		if (!command) {
			throw error(400, 'No dev command configured for this project');
		}
		// Save command if provided
		if (body.command) {
			setDevCommand(cwd, body.command);
		}
		if (isDevServerRunning(cwd)) {
			throw error(409, 'Dev server already running');
		}
		startDevServer(cwd, command);
		return json({ ok: true });
	}

	if (action === 'stop') {
		await stopDevServer(cwd);
		return json({ ok: true });
	}

	throw error(400, `Unknown action: ${action}`);
};
