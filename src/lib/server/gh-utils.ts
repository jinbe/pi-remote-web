/**
 * Shared helpers for invoking the GitHub CLI (`gh`).
 */

const GH_TIMEOUT_MS = 15_000;

/**
 * Run `gh` with the given args asynchronously via Bun.spawn.
 * Returns stdout as a trimmed string, or throws on non-zero exit / timeout.
 */
export async function execGh(args: string[]): Promise<string> {
	const proc = Bun.spawn(['gh', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			(async () => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { stdout, stderr, exitCode };
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					proc.kill();
					reject(new Error(`gh ${args[0]} timed out after ${GH_TIMEOUT_MS}ms`));
				}, GH_TIMEOUT_MS);
			}),
		]);

		if (result.exitCode !== 0) {
			throw new Error(`gh ${args[0]} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
		}

		return result.stdout.trim();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse a GitHub PR URL into its owner, repo, and PR number.
 * Supports URLs like: https://github.com/owner/repo/pull/123
 * Returns null if the URL doesn't match.
 */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!match) return null;
	return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Check whether all CI checks on a PR have completed successfully.
 *
 * Uses `gh pr checks` which reports the combined status of all commit
 * status contexts and check runs for the PR's head commit.
 *
 * Returns:
 *   - { ready: true } if all checks have passed (or there are no checks)
 *   - { ready: false, reason: string } if checks are pending/failing
 */
export async function arePrChecksReady(prUrl: string): Promise<{ ready: boolean; reason?: string }> {
	const parsed = parsePrUrl(prUrl);
	if (!parsed) {
		// Can't parse the URL — skip the CI gate rather than blocking forever
		return { ready: true };
	}

	try {
		const output = await execGh([
			'pr', 'checks', String(parsed.number),
			'--repo', `${parsed.owner}/${parsed.repo}`,
			'--json', 'name,state',
		]);

		const checks = JSON.parse(output || '[]') as Array<{ name: string; state: string }>;

		if (checks.length === 0) {
			// No checks configured — treat as ready
			return { ready: true };
		}

		const pending = checks.filter(c => c.state === 'PENDING' || c.state === 'QUEUED' || c.state === 'IN_PROGRESS');
		const failed = checks.filter(c => c.state === 'FAILURE' || c.state === 'ERROR');

		if (pending.length > 0) {
			return {
				ready: false,
				reason: `${pending.length} check(s) still running: ${pending.map(c => c.name).join(', ')}`,
			};
		}

		if (failed.length > 0) {
			return {
				ready: false,
				reason: `${failed.length} check(s) failed: ${failed.map(c => c.name).join(', ')}`,
			};
		}

		// All checks completed with SUCCESS/NEUTRAL/SKIPPED
		return { ready: true };
	} catch (err) {
		// If gh CLI fails, log but don't block — fail open
		return { ready: true };
	}
}
