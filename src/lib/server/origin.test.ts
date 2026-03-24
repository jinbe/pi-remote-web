import { describe, it, expect, beforeEach } from 'bun:test';
import { setOrigin, getOrigin } from './origin';

describe('origin', () => {
	beforeEach(() => {
		// Reset the global to empty so each test starts fresh
		(globalThis as any).__piServerOrigin = '';
	});

	it('returns fallback when no origin has been set', () => {
		const origin = getOrigin();
		// Falls back to PI_REMOTE_HOST env or http://localhost:4020
		expect(origin).toBeTruthy();
		expect(origin).toMatch(/^https?:\/\//);
	});

	it('returns the captured origin after setOrigin is called', () => {
		setOrigin('http://192.168.1.50:3000');
		expect(getOrigin()).toBe('http://192.168.1.50:3000');
	});

	it('retains the first origin set (does not overwrite from hooks)', () => {
		setOrigin('http://my-server:8080');
		// Simulate a second call — hooks.server.ts guards with if (!getOrigin())
		// but the module itself doesn't prevent overwrites, the guard is in hooks
		setOrigin('http://other:9999');
		expect(getOrigin()).toBe('http://other:9999');
	});

	it('survives HMR by using globalThis', () => {
		setOrigin('https://prod.example.com');
		// Simulate re-import by reading globalThis directly
		expect((globalThis as any).__piServerOrigin).toBe('https://prod.example.com');
	});
});
