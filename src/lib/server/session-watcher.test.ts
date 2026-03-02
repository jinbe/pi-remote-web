import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

describe('session watcher callback pattern', () => {
	it('registers and calls file-changed callbacks', () => {
		const callbacks = new Set<(filePath: string) => void>();
		const callback = mock(() => {});
		callbacks.add(callback);

		for (const cb of callbacks) cb('/path/to/session.jsonl');

		expect(callback).toHaveBeenCalledWith('/path/to/session.jsonl');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('unregisters callbacks', () => {
		const callbacks = new Set<(filePath: string) => void>();
		const callback = mock(() => {});
		callbacks.add(callback);
		callbacks.delete(callback);

		for (const cb of callbacks) cb('/path/to/session.jsonl');
		expect(callback).not.toHaveBeenCalled();
	});

	it('debounces session-changed notifications', async () => {
		const sessionCallbacks = new Set<(event: 'update') => void>();
		const callback = mock(() => {});
		sessionCallbacks.add(callback);

		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		function notifySessionChanged() {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				for (const cb of sessionCallbacks) cb('update');
			}, 50); // short debounce for test speed
		}

		// Rapid fire notifications
		notifySessionChanged();
		notifySessionChanged();
		notifySessionChanged();

		// Should not have been called yet
		expect(callback).not.toHaveBeenCalled();

		// Wait for debounce
		await new Promise((r) => setTimeout(r, 100));
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith('update');
	});

	it('supports multiple subscribers', () => {
		const callbacks = new Set<(filePath: string) => void>();
		const cb1 = mock(() => {});
		const cb2 = mock(() => {});
		callbacks.add(cb1);
		callbacks.add(cb2);

		for (const cb of callbacks) cb('/test.jsonl');

		expect(cb1).toHaveBeenCalledTimes(1);
		expect(cb2).toHaveBeenCalledTimes(1);
	});

	it('handles removing one callback while keeping others', () => {
		const callbacks = new Set<(filePath: string) => void>();
		const cb1 = mock(() => {});
		const cb2 = mock(() => {});
		callbacks.add(cb1);
		callbacks.add(cb2);

		// Remove cb1
		callbacks.delete(cb1);

		for (const cb of callbacks) cb('/test.jsonl');

		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).toHaveBeenCalledTimes(1);
	});
});
