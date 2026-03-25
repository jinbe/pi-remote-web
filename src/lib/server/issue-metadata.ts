/**
 * Parse issue URLs (GitHub, Linear) and fetch metadata via `gh` CLI.
 * Used to infer job title and description from an issue URL.
 */
import { execFileSync } from 'child_process';
import { log } from './logger';

// --- Constants ---

/** Pattern for GitHub issue URLs: https://github.com/<owner>/<repo>/issues/<number> */
const GITHUB_ISSUE_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

/** Pattern for Linear issue URLs: https://linear.app/<team>/issue/<id>/<slug> */
const LINEAR_ISSUE_PATTERN = /^https:\/\/linear\.app\/([^/]+)\/issue\/([^/]+)\/([^/]+)\/?$/;

/** Timeout for `gh` CLI calls (milliseconds). */
const GH_TIMEOUT_MS = 5_000;

// --- Types ---

export interface ParsedIssueUrl {
	provider: 'github' | 'linear';
	owner: string;
	repo: string;
	issueNumber: number;
}

export interface ParsedLinearUrl {
	provider: 'linear';
	team: string;
	id: string;
	slug: string;
}

export interface IssueMetadata {
	title: string;
	description: string;
}

// --- URL parsing ---

/**
 * Parse a GitHub issue URL into its components.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parseIssueUrl(url: string): ParsedIssueUrl | null {
	const match = url.trim().match(GITHUB_ISSUE_PATTERN);
	if (!match) return null;

	return {
		provider: 'github',
		owner: match[1],
		repo: match[2],
		issueNumber: parseInt(match[3], 10),
	};
}

/**
 * Parse a Linear issue URL into its components.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parseLinearUrl(url: string): ParsedLinearUrl | null {
	const match = url.trim().match(LINEAR_ISSUE_PATTERN);
	if (!match) return null;

	return {
		provider: 'linear',
		team: match[1],
		id: match[2],
		slug: match[3],
	};
}

// --- Metadata fetching ---

/**
 * Fetch issue metadata from GitHub using the `gh` CLI.
 * Returns null if the URL is not a GitHub issue or the call fails.
 */
export function fetchIssueMetadata(issueUrl: string): IssueMetadata | null {
	const parsed = parseIssueUrl(issueUrl);
	if (!parsed) return null;

	try {
		const output = execFileSync(
			'gh',
			['issue', 'view', String(parsed.issueNumber), '--repo', `${parsed.owner}/${parsed.repo}`, '--json', 'title,body'],
			{ timeout: GH_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
		);

		const data = JSON.parse(output);
		return {
			title: data.title ?? `Issue #${parsed.issueNumber}`,
			description: data.body ?? '',
		};
	} catch (err) {
		log.warn('issue-metadata', `failed to fetch issue metadata for ${issueUrl}: ${err}`);
		return null;
	}
}

/**
 * Build a fallback title from an issue URL when `gh` is unavailable.
 * Returns "Issue #<n>" for GitHub, the slug for Linear, or the raw URL otherwise.
 */
export function fallbackIssueTitle(issueUrl: string): string {
	const github = parseIssueUrl(issueUrl);
	if (github) return `Issue #${github.issueNumber}`;

	const linear = parseLinearUrl(issueUrl);
	if (linear) return linear.slug.replace(/-/g, ' ');

	return issueUrl;
}
