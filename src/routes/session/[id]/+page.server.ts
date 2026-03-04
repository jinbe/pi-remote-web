import {
	decodeSessionId,
	parseSessionMetadata
} from '$lib/server/session-scanner';
import { isActive, getActiveSession } from '$lib/server/rpc-manager';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Read the current git branch for a directory, or null if not a git repo. */
async function getGitBranch(cwd: string): Promise<string | null> {
	if (!cwd) return null;
	try {
		const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd,
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;
		return text.trim() || null;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const filePath = decodeSessionId(params.id);
	const active = isActive(params.id);

	// Try loading metadata from the JSONL file
	try {
		const meta = await parseSessionMetadata(filePath);
		const gitBranch = await getGitBranch(meta.cwd);
		return {
			sessionId: params.id,
			filePath,
			meta: {
				...meta,
				lastModified: meta.lastModified.toISOString()
			},
			isActive: active,
			gitBranch
		};
	} catch {
		// File may not be ready yet for newly created sessions
	}

	// Fallback for active sessions whose file isn't scannable yet
	if (active) {
		const info = getActiveSession(params.id);
		const gitBranch = await getGitBranch(info?.cwd ?? '');
		return {
			sessionId: params.id,
			filePath,
			meta: {
				id: params.id,
				filePath,
				cwd: info?.cwd ?? '',
				name: null,
				firstMessage: '(new session)',
				lastModified: new Date().toISOString(),
				messageCount: 0,
				model: info?.model ?? null
			},
			isActive: true,
			gitBranch
		};
	}

	throw error(404, 'Session not found');
};
