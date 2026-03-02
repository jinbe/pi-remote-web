import { test, expect } from '@playwright/test';

test.describe('API Routes', () => {
	test.describe('GET /api/favorites', () => {
		test('returns an array', async ({ request }) => {
			const res = await request.get('/api/favorites');
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body)).toBe(true);
		});
	});

	test.describe('POST /api/favorites', () => {
		test('rejects invalid cwd', async ({ request }) => {
			const res = await request.post('/api/favorites', {
				data: { cwd: '/nonexistent/path/xyz123', action: 'add' }
			});
			expect(res.status()).toBe(400);
		});

		// Note: empty cwd resolves to process.cwd() which exists, so it returns 200
		test('empty cwd resolves to cwd and succeeds', async ({ request }) => {
			const res = await request.post('/api/favorites', {
				data: { cwd: '', action: 'add' }
			});
			// resolve('') returns process.cwd() which exists
			expect(res.status()).toBe(200);
		});
	});

	test.describe('POST /api/sessions/new', () => {
		// Note: empty cwd resolves to process.cwd() which exists, so the server
		// attempts to create a session (which may succeed or fail depending on pi binary)
		test('empty cwd attempts session creation', async ({ request }) => {
			const res = await request.post('/api/sessions/new', {
				data: { cwd: '' }
			});
			// resolve('') = process.cwd() which exists, so it tries to create.
			// It returns 200 if pi is available, or 500 if not — either way not 400
			expect([200, 500]).toContain(res.status());
		});

		test('rejects nonexistent cwd', async ({ request }) => {
			const res = await request.post('/api/sessions/new', {
				data: { cwd: '/nonexistent/path/xyz123' }
			});
			expect(res.status()).toBe(400);
		});
	});

	test.describe('POST /api/sessions/stop-all', () => {
		test('returns success even with no active sessions', async ({ request }) => {
			const res = await request.post('/api/sessions/stop-all');
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.ok).toBe(true);
			expect(typeof body.stopped).toBe('number');
		});
	});

	test.describe('GET /api/dev-server', () => {
		test('returns dev server status', async ({ request }) => {
			const res = await request.get('/api/dev-server');
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty('commands');
			expect(body).toHaveProperty('running');
			expect(Array.isArray(body.running)).toBe(true);
		});
	});

	test.describe('POST /api/dev-server', () => {
		test('rejects invalid cwd', async ({ request }) => {
			const res = await request.post('/api/dev-server', {
				data: { action: 'start', cwd: '/nonexistent/xyz123', command: 'npm run dev' }
			});
			expect(res.status()).toBe(400);
		});

		test('rejects unknown action', async ({ request }) => {
			const res = await request.post('/api/dev-server', {
				data: { action: 'unknown', cwd: '/' }
			});
			expect(res.status()).toBe(400);
		});
	});

	test.describe('Session-specific endpoints with invalid ID', () => {
		const fakeId = Buffer.from('/invalid/path.jsonl').toString('base64url');

		test('GET state returns inactive for unknown session', async ({ request }) => {
			const res = await request.get(`/api/sessions/${fakeId}/state`);
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.active).toBe(false);
		});

		test('GET stats returns inactive for unknown session', async ({ request }) => {
			const res = await request.get(`/api/sessions/${fakeId}/stats`);
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.active).toBe(false);
		});

		test('GET commands returns empty for unknown session', async ({ request }) => {
			const res = await request.get(`/api/sessions/${fakeId}/commands`);
			expect(res.status()).toBe(200);
			const body = await res.json();
			expect(body.commands).toEqual([]);
		});

		test('POST prompt fails for inactive session', async ({ request }) => {
			const res = await request.post(`/api/sessions/${fakeId}/prompt`, {
				data: { message: 'hello' }
			});
			expect(res.status()).toBe(500);
		});

		test('POST prompt rejects empty message', async ({ request }) => {
			const res = await request.post(`/api/sessions/${fakeId}/prompt`, {
				data: { message: '' }
			});
			expect(res.status()).toBe(400);
		});

		test('POST abort fails for inactive session', async ({ request }) => {
			const res = await request.post(`/api/sessions/${fakeId}/abort`);
			expect(res.status()).toBe(500);
		});
	});
});
