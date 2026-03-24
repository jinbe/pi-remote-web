/**
 * Parse GitHub PR URLs and fetch PR metadata via `gh` CLI.
 * Used to infer job title, branch, and target branch from a PR URL.
 */
import { execFileSync } from 'child_process';
import { log } from './logger';

// --- Constants ---

/** Pattern for GitHub PR URLs: https://github.com/<owner>/<repo>/pull/<number> */
const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

/** Timeout for `gh` CLI calls (milliseconds). */
const GH_TIMEOUT_MS = 5_000;

// --- Types ---

export interface ParsedPrUrl {
	owner: string;
	repo: string;
	prNumber: number;
}

export interface PrMetadata {
	title: string;
	branch: string;
	targetBranch: string;
	prNumber: number;
}

// --- URL parsing ---

/**
 * Parse a GitHub PR URL into its components.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parsePrUrl(url: string): ParsedPrUrl | null {
	const match = url.trim().match(PR_URL_PATTERN);
	if (!match) return null;

	return {
		owner: match[1],
		repo: match[2],
		prNumber: parseInt(match[3], 10),
	};
}

// --- Metadata fetching ---

/**
 * Fetch PR metadata from GitHub using the `gh` CLI.
 * Returns null if the call fails (gh not installed, auth issues, network, etc.).
 */
export function fetchPrMetadata(prUrl: string): PrMetadata | null {
	const parsed = parsePrUrl(prUrl);
	if (!parsed) return null;

	try {
		const output = execFileSync(
			'gh',
			['pr', 'view', String(parsed.prNumber), '--repo', `${parsed.owner}/${parsed.repo}`, '--json', 'title,headRefName,baseRefName'],
			{ timeout: GH_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
		);

		const data = JSON.parse(output);
		return {
			title: data.title ?? `PR #${parsed.prNumber}`,
			branch: data.headRefName ?? '',
			targetBranch: data.baseRefName ?? 'main',
			prNumber: parsed.prNumber,
		};
	} catch (err) {
		log.warn('pr-metadata', `failed to fetch PR metadata for ${prUrl}: ${err}`);
		return null;
	}
}

/**
 * Build a fallback title from a PR URL when `gh` is unavailable.
 * Returns the PR number as "PR #<n>" or the raw URL if parsing fails.
 */
export function fallbackTitle(prUrl: string): string {
	const parsed = parsePrUrl(prUrl);
	return parsed ? `PR #${parsed.prNumber}` : prUrl;
}
