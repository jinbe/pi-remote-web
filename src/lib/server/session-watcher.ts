import { watch } from 'fs';
import { join } from 'path';

const fileCallbacks = new Set<(filePath: string) => void>();
const sessionCallbacks = new Set<(event: 'update') => void>();

/** Per-directory debounce timers so each watcher debounces independently. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startWatching(sessionsDir: string) {
	try {
		watch(sessionsDir, { recursive: true }, (_eventType, filename) => {
			if (filename?.endsWith('.jsonl')) {
				const fullPath = join(sessionsDir, filename);

				for (const cb of fileCallbacks) cb(fullPath);

				const existing = debounceTimers.get(sessionsDir);
				if (existing) clearTimeout(existing);
				debounceTimers.set(sessionsDir, setTimeout(() => {
					debounceTimers.delete(sessionsDir);
					for (const cb of sessionCallbacks) cb('update');
				}, 500));
			}
		});
	} catch {
		console.warn('Could not start file watcher on', sessionsDir);
	}
}

export function onFileChanged(callback: (filePath: string) => void): () => void {
	fileCallbacks.add(callback);
	return () => fileCallbacks.delete(callback);
}

export function onSessionsChanged(callback: (event: 'update') => void): () => void {
	sessionCallbacks.add(callback);
	return () => sessionCallbacks.delete(callback);
}
