import { pruneCache, warmCache, registerCacheInvalidation } from './cache';
import { warmAllSessions } from './session-scanner';
import { recoverActiveSessions } from './rpc-manager';
import { startWatching } from './session-watcher';
import { homedir } from 'os';
import { join } from 'path';

let initialized = false;

export async function ensureInit() {
	if (initialized) return;
	initialized = true;

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

	console.log('Pi Dashboard initialized');
}
