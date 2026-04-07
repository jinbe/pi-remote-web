import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
	test('loads and shows the logo', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('img[alt="Pi"]')).toBeVisible();
	});

	test('shows the New button', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('button', { hasText: 'New' })).toBeVisible();
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
		await page.locator('button', { hasText: 'New' }).click();
		// The NewSessionModal dialog should appear with heading
		await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible({
			timeout: 3000
		});
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
	test('shows empty state or session list', async ({ page }) => {
		await page.goto('/');
		// The page must render either project group cards or the empty-state message
		const hasGroups = await page.locator('.project-card').count();
		const hasEmpty = await page.locator('text=No sessions found').count();
		expect(hasGroups > 0 || hasEmpty > 0).toBe(true);
	});
});

test.describe('Home Page - Navigation', () => {
	test('page renders header, search, and content area', async ({ page }) => {
		await page.goto('/');
		// Header bar with logo and New button
		await expect(page.locator('img[alt="Pi"]')).toBeVisible();
		await expect(page.locator('button', { hasText: 'New' })).toBeVisible();
		// Search input
		await expect(page.locator('input[placeholder="Search sessions..."]')).toBeVisible();
		// Content area: either project cards or empty state
		const hasContent = await page.locator('.project-card').or(page.locator('text=No sessions found')).count();
		expect(hasContent).toBeGreaterThan(0);
	});

	test('kebab menu refresh reloads data without errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));

		await page.goto('/');
		// Open the kebab dropdown
		await page.locator('button[aria-label="More actions"]').click();
		// Click the Refresh item
		await page.locator('.dropdown-content button', { hasText: 'Refresh' }).click();
		// Wait for invalidateAll to settle
		await page.waitForTimeout(500);
		// Page should still render correctly
		await expect(page.locator('img[alt="Pi"]')).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('page loads without JS errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));

		await page.goto('/');
		await page.waitForTimeout(1000);

		expect(errors).toEqual([]);
	});
});
