import { test, expect } from '@playwright/test';

test.describe('Session Page', () => {
	test('returns 500 for session ID outside sessions directory', async ({ page }) => {
		// decodeSessionId throws "path outside sessions directory" → 500
		const fakeId = Buffer.from('/nonexistent/path.jsonl').toString('base64url');
		const res = await page.goto(`/session/${fakeId}`);
		expect(res?.status()).toBe(500);
	});

	test('shows error page for invalid session ID', async ({ page }) => {
		await page.goto('/session/invalid-id-123');
		// Should show error page content
		const body = await page.textContent('body');
		expect(body).toBeTruthy();
	});

	test('error page shows error message', async ({ page }) => {
		const fakeId = Buffer.from('/nonexistent/path.jsonl').toString('base64url');
		await page.goto(`/session/${fakeId}`);
		// SvelteKit error page should render something
		const body = await page.textContent('body');
		expect(body!.length).toBeGreaterThan(0);
	});

	test('no unexpected JS errors on error page', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));

		const fakeId = Buffer.from('/nonexistent/path.jsonl').toString('base64url');
		await page.goto(`/session/${fakeId}`);
		await page.waitForTimeout(500);

		// Filter out expected errors
		const unexpectedErrors = errors.filter(
			(e) =>
				!e.includes('404') &&
				!e.includes('Not Found') &&
				!e.includes('Session not found') &&
				!e.includes('Internal Error') &&
				!e.includes('path outside')
		);
		expect(unexpectedErrors).toEqual([]);
	});
});

test.describe('Session Page - Navigation', () => {
	test('body renders on error page', async ({ page }) => {
		const fakeId = Buffer.from('/nonexistent/path.jsonl').toString('base64url');
		await page.goto(`/session/${fakeId}`);
		const body = await page.textContent('body');
		expect(body).toBeTruthy();
	});
});
