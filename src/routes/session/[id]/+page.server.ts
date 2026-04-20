import {
	decodeSessionId,
	parseSessionMetadata,
	listSessions
} from '$lib/server/session-scanner';
import { existsSync } from 'fs';
import { isActive, getActiveSession, getActiveSessionIds, getStreamingState } from '$lib/server/rpc-manager';
import { getFavoriteProjects, getAllDevCommands } from '$lib/server/cache';
import { getRunningDevServerCwds } from '$lib/server/dev-server-manager';
import { getJobs } from '$lib/server/job-queue';
import { error } from '@sveltejs/kit';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'claimed', 'running', 'reviewing']);
import type { PageServerLoad } from './$types';

export interface SidebarSession {
	id: string;
	name: string | null;
	firstMessage: string;
	lastModified: string;
	messageCount: number;
	model: string | null;
	harness: string | null;
	isCurrent: boolean;
	isActive: boolean;
	isStreaming: boolean;
}

export interface SidebarProject {
	cwd: string;
	shortName: string;
	isFavorite: boolean;
	hasActive: boolean;
	hasStreaming: boolean;
	devCommand: string | null;
	devServerRunning: boolean;
	latestModified: string;
	containsCurrent: boolean;
	sessions: SidebarSession[];
}

/**
 * Build the full project navigation tree for the sidebar — every cwd that has
 * sessions, with its sessions, status, dev-server state, and a `containsCurrent`
 * flag so the UI can auto-expand the current project.
 *
 * Sorted: favorites first, active second, then by recency. Identical ordering
 * to the dashboard route so navigating between them feels stable.
 */
async function getSidebarProjects(currentId: string): Promise<SidebarProject[]> {
	const allSessions = await listSessions();
	const activeIds = new Set(getActiveSessionIds());
	const favSet = new Set(getFavoriteProjects());
	const devCommands = Object.fromEntries(getAllDevCommands());
	const runningDevSet = new Set(getRunningDevServerCwds());

	const groups = new Map<string, SidebarSession[]>();
	for (const s of allSessions) {
		const list = groups.get(s.cwd);
		const session: SidebarSession = {
			id: s.id,
			name: s.name,
			firstMessage: s.firstMessage,
			lastModified: s.lastModified.toISOString(),
			messageCount: s.messageCount,
			model: s.model,
			harness: s.harness ?? null,
			isCurrent: s.id === currentId,
			isActive: activeIds.has(s.id),
			isStreaming: activeIds.has(s.id) && getStreamingState(s.id).isStreaming,
		};
		if (list) list.push(session);
		else groups.set(s.cwd, [session]);
	}

	const result: SidebarProject[] = [];
	for (const [cwd, sessions] of groups) {
		const hasActive = sessions.some((s) => s.isActive);
		const hasStreaming = sessions.some((s) => s.isStreaming);
		const containsCurrent = sessions.some((s) => s.isCurrent);
		result.push({
			cwd,
			shortName: cwd.split('/').filter(Boolean).slice(-2).join('/'),
			isFavorite: favSet.has(cwd),
			hasActive,
			hasStreaming,
			devCommand: (devCommands[cwd] as string) ?? null,
			devServerRunning: runningDevSet.has(cwd),
			latestModified: sessions[0]?.lastModified ?? '',
			containsCurrent,
			sessions,
		});
	}

	result.sort((a, b) => {
		if (a.containsCurrent !== b.containsCurrent) return a.containsCurrent ? -1 : 1;
		if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
		if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
		return b.latestModified.localeCompare(a.latestModified);
	});

	return result;
}

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

	// Try loading metadata from the JSONL file (if it exists)
	if (existsSync(filePath)) {
		try {
			const meta = await parseSessionMetadata(filePath);
			const [gitBranch, projects] = await Promise.all([
				getGitBranch(meta.cwd),
				getSidebarProjects(params.id),
			]);
			return {
				sessionId: params.id,
				filePath,
				meta: {
					...meta,
					lastModified: meta.lastModified.toISOString()
				},
				isActive: active,
				gitBranch,
				projects,
				activeCount: projects.reduce((n, p) => n + p.sessions.filter((s) => s.isActive).length, 0),
				activeJobCount: getJobs().filter((j) => ACTIVE_JOB_STATUSES.has(j.status)).length,
			};
		} catch {
			// File may not be parseable
		}
	}

	// Fallback for active sessions whose file isn't scannable yet
	if (active) {
		const info = getActiveSession(params.id);
		const cwd = info?.cwd ?? '';
		const [gitBranch, projects] = await Promise.all([
			getGitBranch(cwd),
			getSidebarProjects(params.id),
		]);
		return {
			sessionId: params.id,
			filePath,
			meta: {
				id: params.id,
				filePath,
				cwd,
				name: null,
				firstMessage: '(new session)',
				lastModified: new Date().toISOString(),
				messageCount: 0,
				model: info?.model ?? null
			},
			isActive: true,
			gitBranch,
			projects,
			activeCount: projects.reduce((n, p) => n + p.sessions.filter((s) => s.isActive).length, 0),
		};
	}

	throw error(404, 'Session not found');
};
