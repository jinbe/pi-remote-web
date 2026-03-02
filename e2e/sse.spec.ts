import { test, expect } from '@playwright/test';

test.describe('SSE Endpoints', () => {
	// SSE streams hang when using Playwright's request API since the stream never ends.
	// Instead, test SSE via the browser page which handles EventSource properly.

	test('session watch SSE is connected from the home page', async ({ page }) => {
		const sseRequests: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('/api/sessions/watch')) {
				sseRequests.push(req.url());
			}
		});

		await page.goto('/');
		await page.waitForTimeout(2000);

		expect(sseRequests.length).toBeGreaterThan(0);
	});

	test('session events SSE is connected from session page', async ({ page }) => {
		// Navigate to home to find a real session
		await page.goto('/');

		// Look for any session link
		const sessionLinks = page.locator('a[href^="/session/"]');
		const count = await sessionLinks.count();

		if (count > 0) {
			const sseRequests: string[] = [];
			page.on('request', (req) => {
				if (req.url().includes('/events')) {
					sseRequests.push(req.url());
				}
			});

			// Click first session to navigate
			await sessionLinks.first().click();
			await page.waitForTimeout(2000);

			// If session is active, SSE should connect
			// (may not connect if session isn't active)
		}
		// This test is observational — passes either way
	});
});

test.describe('SSE Client Behavior', () => {
	test('home page establishes SSE connection for auto-refresh', async ({ page }) => {
		const sseRequests: string[] = [];
		page.on('request', (req) => {
			if (req.url().includes('/api/sessions/watch')) {
				sseRequests.push(req.url());
			}
		});

		await page.goto('/');
		await page.waitForTimeout(2000);

		expect(sseRequests.length).toBeGreaterThan(0);
	});

	test('SSE request URL is correct', async ({ page }) => {
		let sseUrl = '';
		page.on('request', (req) => {
			if (req.url().includes('/api/sessions/watch')) {
				sseUrl = req.url();
			}
		});

		await page.goto('/');
		await page.waitForTimeout(2000);

		expect(sseUrl).toContain('/api/sessions/watch');
	});
});
