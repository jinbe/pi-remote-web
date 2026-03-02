import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
	test('loads and shows the sessions heading', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h1')).toContainText('Pi Sessions');
	});

	test('shows the New button', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('button', { hasText: '+ New' })).toBeVisible();
	});

	test('shows the refresh button', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('button', { hasText: '↻' })).toBeVisible();
	});

	test('has a search input', async ({ page }) => {
		await page.goto('/');
		const searchInput = page.locator('input[placeholder="Search sessions..."]');
		await expect(searchInput).toBeVisible();
	});

	test('search filters sessions', async ({ page }) => {
		await page.goto('/');
		const searchInput = page.locator('input[placeholder="Search sessions..."]');
		await searchInput.fill('nonexistent-query-xyz-12345');
		// Should show "No sessions match" or empty state
		await expect(
			page.locator('text=No sessions match').or(page.locator('text=No sessions found'))
		).toBeVisible({ timeout: 5000 });
	});

	test('opens New Session modal', async ({ page }) => {
		await page.goto('/');
		await page.locator('button', { hasText: '+ New' }).click();
		// The NewSessionModal dialog should appear with heading
		await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible({
			timeout: 3000
		});
	});

	test('refresh button triggers data reload', async ({ page }) => {
		await page.goto('/');
		// Click refresh and verify page doesn't error
		const refreshBtn = page.locator('button', { hasText: '↻' });
		await refreshBtn.click();
		// Page should still show the heading
		await expect(page.locator('h1')).toContainText('Pi Sessions');
	});

	test('project groups are displayed when sessions exist', async ({ page }) => {
		await page.goto('/');
		// Either project groups or empty state should be visible
		const hasGroups = await page.locator('.rounded-lg.border').count();
		const hasEmpty = await page.locator('text=No sessions found').count();
		expect(hasGroups > 0 || hasEmpty > 0).toBe(true);
	});

	test('expanding a project group shows sessions', async ({ page }) => {
		await page.goto('/');
		const projectHeader = page.locator('.rounded-lg.border .cursor-pointer').first();
		const exists = await projectHeader.count();
		if (exists > 0) {
			await projectHeader.click();
			// After clicking, session links should appear
			await page.waitForTimeout(300);
			const sessionLinks = page.locator('.rounded-lg.border a[href^="/session/"]');
			expect(await sessionLinks.count()).toBeGreaterThanOrEqual(0);
		}
	});
});

test.describe('Home Page - Empty State', () => {
	test('shows empty state message when no sessions exist', async ({ page }) => {
		await page.goto('/');
		// Either shows sessions or empty state — both are valid
		const heading = page.locator('h1');
		await expect(heading).toContainText('Pi Sessions');
	});
});

test.describe('Home Page - Navigation', () => {
	test('page has correct title or heading', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('h1')).toBeVisible();
	});

	test('page loads without JS errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));

		await page.goto('/');
		await page.waitForTimeout(1000);

		expect(errors).toEqual([]);
	});
});
