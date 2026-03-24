import { pruneCache, warmCache, registerCacheInvalidation } from './cache';
import { warmAllSessions } from './session-scanner';
import { recoverActiveSessions } from './rpc-manager';
import { startWatching } from './session-watcher';
import { start as startJobPoller } from './job-poller';
import { homedir } from 'os';
import { join } from 'path';

// Use globalThis to survive HMR module re-evaluation
const g = globalThis as any;
if (g.__piInitialized === undefined) g.__piInitialized = false;

export async function ensureInit() {
	if (g.__piInitialized) return;
	g.__piInitialized = true;

	await pruneCache();
	registerCacheInvalidation();

	await recoverActiveSessions();

	warmCache(async () => {
		try {
			await warmAllSessions();
		} catch (e) {
			console.error('Cache warming failed:', e);
		}
	});

	const sessionsDir = process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');
	startWatching(sessionsDir);

	// Start the job queue poller (claims and dispatches queued jobs)
	startJobPoller();

	console.log('Pi Dashboard initialized');
}
