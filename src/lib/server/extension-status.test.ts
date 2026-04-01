import { describe, it, expect } from 'bun:test';
import { getExtensionStatus } from './extension-status';

describe('extension-status', () => {
	describe('getExtensionStatus', () => {
		it('returns a valid status object', async () => {
			const status = await getExtensionStatus();

			expect(status).toHaveProperty('installed');
			expect(status).toHaveProperty('isSymlink');
			expect(status).toHaveProperty('repoVersion');
			expect(status).toHaveProperty('installedVersion');
			expect(status).toHaveProperty('upToDate');
			expect(status).toHaveProperty('repoPath');
			expect(status).toHaveProperty('installedPath');
		});

		it('detects the repo version from the extension source', async () => {
			const status = await getExtensionStatus();

			// The repo extension should exist and have a version
			expect(status.repoVersion).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it('reports the correct installed path', async () => {
			const status = await getExtensionStatus();

			expect(status.installedPath).toContain('.pi');
			expect(status.installedPath).toContain('extensions');
			expect(status.installedPath).toContain('job-callback.ts');
		});

		it('repoPath points to the extensions directory', async () => {
			const status = await getExtensionStatus();

			expect(status.repoPath).toContain('extensions');
			expect(status.repoPath).toContain('job-callback.ts');
		});
	});
});
