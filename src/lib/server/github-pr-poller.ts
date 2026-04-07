/**
 * GitHub PR Poller — polls monitored repos for open PRs assigned to the
 * authenticated GitHub user and creates review jobs for them.
 *
 * Repos are stored in the `monitored_repos` table with per-repo toggles:
 *   - assigned_only: only PRs assigned to the GH user (default: on)
 *   - manual_only: skip during automatic polling, only check on manual trigger (default: on)
 *   - enabled: master toggle (default: on)
 *
 * Configuration via environment:
 *   PI_PR_POLL_INTERVAL_SECONDS — polling interval (default: 600 = 10 minutes)
 *   PI_PR_POLL_CONCURRENCY — max concurrent running jobs (default: 5)
 */
import { execFileSync } from 'child_process';
import { getDb } from './cache';
import { createJob, findActiveJobByPrUrl } from './job-queue';
import { REVIEW_SKILL } from './job-prompts';
import { getHarness } from './rpc-manager';
import { log } from './logger';

// --- Constants ---

const DEFAULT_POLL_INTERVAL_SECONDS = 600;
const DEFAULT_CONCURRENCY = 5;
const GH_TIMEOUT_MS = 15_000;

/** Per-PR error backoff: skip PRs that have failed review-state checks recently. */
const prErrorBackoff = new Map<string, number>(); // prKey → timestamp when backoff expires
const PR_ERROR_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

/** Statuses that count towards the concurrency limit. */
const ACTIVE_JOB_STATUSES = ['queued', 'claimed', 'running', 'reviewing'];

// --- Types ---

export interface MonitoredRepo {
	id: string;
	owner: string;
	name: string;
	local_path: string | null;
	assigned_only: number;
	manual_only: number;
	enabled: number;
	created_at: string;
	updated_at: string;
}

export interface CreateMonitoredRepoInput {
	owner: string;
	name: string;
	local_path?: string;
	assigned_only?: boolean;
	manual_only?: boolean;
	enabled?: boolean;
}

export interface UpdateMonitoredRepoInput {
	local_path?: string | null;
	assigned_only?: boolean;
	manual_only?: boolean;
	enabled?: boolean;
}

interface GitHubPr {
	number: number;
	title: string;
	headRefName: string;
	baseRefName: string;
	url: string;
	author?: { login: string };
}

// --- Configuration ---

export function getPollIntervalMs(): number {
	const seconds = parseInt(process.env.PI_PR_POLL_INTERVAL_SECONDS ?? '', 10);
	return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
}

export function getConcurrency(): number {
	const val = parseInt(process.env.PI_PR_POLL_CONCURRENCY ?? '', 10);
	return Number.isFinite(val) && val > 0 ? val : DEFAULT_CONCURRENCY;
}

// --- State ---

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// --- Repo CRUD ---

export function getMonitoredRepos(): MonitoredRepo[] {
	return getDb().query('SELECT * FROM monitored_repos ORDER BY owner, name').all() as MonitoredRepo[];
}

export function getMonitoredRepo(id: string): MonitoredRepo | null {
	return getDb().query('SELECT * FROM monitored_repos WHERE id = ?').get(id) as MonitoredRepo | null;
}

export function createMonitoredRepo(input: CreateMonitoredRepoInput): MonitoredRepo {
	const row = getDb().query(`
		INSERT INTO monitored_repos (owner, name, local_path, assigned_only, manual_only, enabled)
		VALUES ($owner, $name, $local_path, $assigned_only, $manual_only, $enabled)
		RETURNING *
	`).get({
		$owner: input.owner,
		$name: input.name,
		$local_path: input.local_path ?? null,
		$assigned_only: input.assigned_only === false ? 0 : 1,
		$manual_only: input.manual_only === false ? 0 : 1,
		$enabled: input.enabled === false ? 0 : 1,
	}) as MonitoredRepo;

	log.info('github-pr-poller', `added repo ${input.owner}/${input.name}`);
	return row;
}

export function updateMonitoredRepo(id: string, updates: UpdateMonitoredRepoInput): MonitoredRepo | null {
	const setClauses: string[] = ["updated_at = datetime('now')"];
	const params: Record<string, any> = { $id: id };

	if (updates.local_path !== undefined) {
		setClauses.push('local_path = $local_path');
		params.$local_path = updates.local_path;
	}
	if (updates.assigned_only !== undefined) {
		setClauses.push('assigned_only = $assigned_only');
		params.$assigned_only = updates.assigned_only ? 1 : 0;
	}
	if (updates.manual_only !== undefined) {
		setClauses.push('manual_only = $manual_only');
		params.$manual_only = updates.manual_only ? 1 : 0;
	}
	if (updates.enabled !== undefined) {
		setClauses.push('enabled = $enabled');
		params.$enabled = updates.enabled ? 1 : 0;
	}

	const sql = `UPDATE monitored_repos SET ${setClauses.join(', ')} WHERE id = $id RETURNING *`;
	const row = getDb().query(sql).get(params) as MonitoredRepo | null;

	if (row) {
		log.info('github-pr-poller', `updated repo ${row.owner}/${row.name}`);
	}
	return row;
}

export function deleteMonitoredRepo(id: string): MonitoredRepo | null {
	const row = getDb().query('DELETE FROM monitored_repos WHERE id = ? RETURNING *').get(id) as MonitoredRepo | null;
	if (row) {
		log.info('github-pr-poller', `removed repo ${row.owner}/${row.name}`);
	}
	return row;
}

// --- GitHub CLI helpers ---

/**
 * Get the authenticated GitHub username via `gh api user`.
 * Returns null if the CLI call fails.
 */
export function getGitHubUser(): string | null {
	try {
		const output = execFileSync(
			'gh', ['api', 'user', '--jq', '.login'],
			{ timeout: GH_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
		);
		return output.trim() || null;
	} catch (err) {
		log.warn('github-pr-poller', `failed to get GitHub user: ${err}`);
		return null;
	}
}

/**
 * List open PRs for a given repo. Optionally filter by assignee.
 */
export function listOpenPrs(owner: string, name: string, assignee?: string, excludeAuthor?: string): GitHubPr[] {
	try {
		const args = [
			'pr', 'list',
			'--repo', `${owner}/${name}`,
			'--state', 'open',
			'--json', 'number,title,headRefName,baseRefName,url,isDraft,author',
			'--limit', '30',
		];

		if (assignee) {
			args.push('--assignee', assignee);
		}

		const output = execFileSync('gh', args, {
			timeout: GH_TIMEOUT_MS,
			stdio: ['pipe', 'pipe', 'pipe'],
			encoding: 'utf-8',
		});

		let prs = JSON.parse(output) as any[];

		// Filter out draft PRs
		prs = prs.filter((pr: any) => !pr.isDraft);

		// Filter out PRs authored by the current user (don't review your own)
		if (excludeAuthor) {
			prs = prs.filter((pr: any) => {
				const login = pr.author?.login || pr.author?.Login || '';
				return login.toLowerCase() !== excludeAuthor.toLowerCase();
			});
		}

		// Filter out bot authors (check is_bot flag + login patterns)
		prs = prs.filter((pr: any) => {
			if (pr.author?.is_bot) return false;
			const login = (pr.author?.login || pr.author?.Login || '').toLowerCase();
			return !BOT_LOGIN_PATTERNS.some(pat => login.includes(pat.toLowerCase()));
		});

		return prs as GitHubPr[];
	} catch (err) {
		log.warn('github-pr-poller', `failed to list PRs for ${owner}/${name}: ${err}`);
		return [];
	}
}

// --- Bot author patterns to exclude ---
// gh pr list returns login as 'app/snyk-io' for GitHub Apps, not 'snyk-io[bot]'
const BOT_LOGIN_PATTERNS = ['dependabot', 'snyk-io', 'renovate', 'github-actions'];

// --- Dismiss keywords: if the last non-author comment contains one, skip ---
const DISMISS_KEYWORDS = [
	'approve', 'lgtm', 'ship it', 'shipit', 'looks good',
	'needs work', 'needs changes', 'changes requested',
	'wip', 'work in progress', 'not ready',
	'hold off', "don't merge", 'do not merge', '+1',
];

/**
 * Check whether a PR needs review by inspecting its review state and comments.
 * Returns { shouldReview: boolean, reason: string }.
 */
function shouldReviewPr(owner: string, name: string, prNumber: number, prAuthor: string, ghUser: string): { shouldReview: boolean; reason: string } {
	// Belt-and-suspenders: never review your own PRs
	if (prAuthor && prAuthor.toLowerCase() === ghUser.toLowerCase()) {
		return { shouldReview: false, reason: `self-authored by ${prAuthor}` };
	}

	try {
		// Fetch reviews
		const reviewsJson = execFileSync('gh', [
			'api', `repos/${owner}/${name}/pulls/${prNumber}/reviews`,
			'--jq', '[.[] | select(.state != "DISMISSED" and .state != "PENDING") | {user: .user.login, state: .state}]',
		], { timeout: GH_TIMEOUT_MS, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

		const reviews = JSON.parse(reviewsJson || '[]') as Array<{ user: string; state: string }>;
		const lastReview = reviews.length > 0 ? reviews[reviews.length - 1] : null;

		// Already approved — skip
		if (lastReview?.state === 'APPROVED') {
			return { shouldReview: false, reason: `already approved by ${lastReview.user}` };
		}

		// My review is the latest — waiting on author
		if (lastReview && lastReview.user.toLowerCase() === ghUser.toLowerCase()) {
			return { shouldReview: false, reason: `last review is mine (${lastReview.state}) — waiting on author` };
		}

		// Fetch last human comment
		const commentsJson = execFileSync('gh', [
			'api', `repos/${owner}/${name}/issues/${prNumber}/comments`,
			'--jq', '[.[] | select(.user.type != "Bot") | {user: .user.login, body: .body}] | last // empty',
		], { timeout: GH_TIMEOUT_MS, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

		if (commentsJson?.trim()) {
			const lastComment = JSON.parse(commentsJson) as { user: string; body: string };

			// Last commenter is NOT the PR author — check dismiss keywords
			if (lastComment.user.toLowerCase() !== prAuthor.toLowerCase()) {
				const lowerBody = (lastComment.body || '').toLowerCase();
				const matched = DISMISS_KEYWORDS.find(kw => lowerBody.includes(kw));
				if (matched) {
					return { shouldReview: false, reason: `last comment by ${lastComment.user} contains "${matched}"` };
				}
				// Non-author commented without dismiss keyword — still skip (they're handling it)
				return { shouldReview: false, reason: `last comment by ${lastComment.user} (not PR author)` };
			}

			// Author commented — re-review needed
			return { shouldReview: true, reason: 'author commented — re-review needed' };
		}

		// No comments — check if there are any reviews
		if (!lastReview) {
			return { shouldReview: true, reason: 'new PR — needs review' };
		}

		return { shouldReview: true, reason: `activity from ${lastReview.user} (${lastReview.state})` };
	} catch (err) {
		log.error('github-pr-poller', `failed to check review state for ${owner}/${name}#${prNumber}: ${err}`);
		// Fail closed — skip this PR and apply a per-PR backoff to avoid endless re-enqueueing
		const prKey = `${owner}/${name}#${prNumber}`;
		prErrorBackoff.set(prKey, Date.now() + PR_ERROR_BACKOFF_MS);
		return { shouldReview: false, reason: 'review state check failed — skipping with backoff' };
	}
}

/**
 * Process a list of PRs for a repo: check review state, skip duplicates, create jobs.
 */
function processPrs(
	prs: GitHubPr[],
	repo: MonitoredRepo,
	ghUser: string,
	concurrency: number,
	result: { created: number; skipped: number; errors: number }
): void {
	for (const pr of prs) {
		if (countActiveJobs() >= concurrency) {
			log.info('github-pr-poller', `concurrency limit reached — stopping PR processing`);
			break;
		}

		const prUrl = pr.url;
		const prAuthor = pr.author?.login || '';

		// Skip if there's already an active job for this PR
		const existing = findActiveJobByPrUrl(prUrl);
		if (existing) {
			log.info('github-pr-poller', `skipping ${repo.owner}/${repo.name}#${pr.number} — active job exists (${existing.status})`);
			result.skipped++;
			continue;
		}



		// Check per-PR error backoff — skip if a recent review-state check failed
		const prKey = `${repo.owner}/${repo.name}#${pr.number}`;
		const backoffExpiry = prErrorBackoff.get(prKey);
		if (backoffExpiry && Date.now() < backoffExpiry) {
			log.info('github-pr-poller', `skipping ${prKey} — in error backoff until ${new Date(backoffExpiry).toISOString()}`);
			result.skipped++;
			continue;
		}
		if (backoffExpiry) prErrorBackoff.delete(prKey); // expired — clean up

		// Check review state — skip if already handled
		const { shouldReview, reason } = shouldReviewPr(repo.owner, repo.name, pr.number, prAuthor, ghUser);
		if (!shouldReview) {
			log.info('github-pr-poller', `skipping ${repo.owner}/${repo.name}#${pr.number} — ${reason}`);
			result.skipped++;
			continue;
		}

		log.info('github-pr-poller', `${repo.owner}/${repo.name}#${pr.number}: ${reason}`);

		// Create a review job
		try {
			const job = createJob({
				type: 'review',
				title: pr.title || `PR #${pr.number}`,
				repo: repo.local_path ?? undefined,
				branch: pr.headRefName,
				target_branch: pr.baseRefName,
				pr_url: prUrl,
				review_skill: REVIEW_SKILL || undefined,
				harness: getHarness(),
			});
			log.info('github-pr-poller', `created review job ${job.id} for ${repo.owner}/${repo.name}#${pr.number}`);
			result.created++;
		} catch (err) {
			log.error('github-pr-poller', `failed to create job for ${repo.owner}/${repo.name}#${pr.number}: ${err}`);
			result.errors++;
		}
	}
}

// --- Active job counting ---

function countActiveJobs(): number {
	const placeholders = ACTIVE_JOB_STATUSES.map(() => '?').join(', ');
	const row = getDb().query(
		`SELECT COUNT(*) as count FROM jobs WHERE status IN (${placeholders})`
	).get(...ACTIVE_JOB_STATUSES) as { count: number };
	return row.count;
}

// --- Polling ---

/**
 * Scan monitored repos for open PRs and create review jobs.
 *
 * @param manualRepoId — if provided, only scan this specific repo (for manual trigger)
 */
export async function scanRepos(manualRepoId?: string): Promise<{ created: number; skipped: number; errors: number }> {
	const result = { created: 0, skipped: 0, errors: 0 };
	const concurrency = getConcurrency();

	// Resolve the GitHub user once for all repos
	const ghUser = getGitHubUser();
	if (!ghUser) {
		log.warn('github-pr-poller', 'cannot determine GitHub user — skipping scan');
		return result;
	}

	// Get repos to scan
	let repos: MonitoredRepo[];
	if (manualRepoId) {
		const repo = getMonitoredRepo(manualRepoId);
		if (!repo) {
			log.warn('github-pr-poller', `repo ${manualRepoId} not found`);
			return result;
		}
		if (!repo.enabled) {
			log.info('github-pr-poller', `repo ${repo.owner}/${repo.name} is disabled — skipping`);
			return result;
		}
		repos = [repo];
	} else {
		// Automatic polling: only enabled repos that are NOT manual_only
		repos = getDb().query(
			'SELECT * FROM monitored_repos WHERE enabled = 1 AND manual_only = 0'
		).all() as MonitoredRepo[];
	}

	if (repos.length === 0) {
		log.info('github-pr-poller', 'no repos to scan');
		return result;
	}

	log.info('github-pr-poller', `scanning ${repos.length} repo(s) as ${ghUser}...`);

	for (const repo of repos) {
		// Check concurrency limit before each repo
		const activeCount = countActiveJobs();
		if (activeCount >= concurrency) {
			log.info('github-pr-poller', `concurrency limit reached (${activeCount}/${concurrency}) — stopping scan`);
			break;
		}

		const assignee = repo.assigned_only ? ghUser : undefined;

		let prs: GitHubPr[];
		try {
			prs = listOpenPrs(repo.owner, repo.name, assignee, ghUser);
		} catch (err) {
			log.error('github-pr-poller', `error listing PRs for ${repo.owner}/${repo.name}: ${err}`);
			result.errors++;
			continue;
		}

		processPrs(prs, repo, ghUser, concurrency, result);
	}

	log.info('github-pr-poller', `scan complete: ${result.created} created, ${result.skipped} skipped, ${result.errors} errors`);
	return result;
}

/**
 * Scan ALL enabled repos (ignoring manual_only). Used for manual "scan all" trigger.
 */
export async function scanAllRepos(): Promise<{ created: number; skipped: number; errors: number }> {
	const result = { created: 0, skipped: 0, errors: 0 };
	const concurrency = getConcurrency();

	const ghUser = getGitHubUser();
	if (!ghUser) {
		log.warn('github-pr-poller', 'cannot determine GitHub user — skipping scan');
		return result;
	}

	const repos = getDb().query(
		'SELECT * FROM monitored_repos WHERE enabled = 1'
	).all() as MonitoredRepo[];

	if (repos.length === 0) {
		log.info('github-pr-poller', 'no repos to scan');
		return result;
	}

	log.info('github-pr-poller', `scanning all ${repos.length} enabled repo(s) as ${ghUser}...`);

	for (const repo of repos) {
		const activeCount = countActiveJobs();
		if (activeCount >= concurrency) {
			log.info('github-pr-poller', `concurrency limit reached (${activeCount}/${concurrency}) — stopping scan`);
			break;
		}

		const assignee = repo.assigned_only ? ghUser : undefined;
		let prs: GitHubPr[];
		try {
			prs = listOpenPrs(repo.owner, repo.name, assignee, ghUser);
		} catch (err) {
			log.error('github-pr-poller', `error listing PRs for ${repo.owner}/${repo.name}: ${err}`);
			result.errors++;
			continue;
		}

		processPrs(prs, repo, ghUser, concurrency, result);
	}

	return result;
}

/**
 * Run a single automatic poll iteration.
 */
export async function pollOnce(): Promise<void> {
	if (isPolling) {
		log.info('github-pr-poller', 'skipping poll — previous iteration still running');
		return;
	}

	isPolling = true;
	try {
		await scanRepos();
	} catch (err) {
		log.error('github-pr-poller', `poll error: ${err}`);
	} finally {
		isPolling = false;
	}
}

// --- Lifecycle ---

export function start(): void {
	if (pollTimer) {
		log.info('github-pr-poller', 'poller already running');
		return;
	}

	const intervalMs = getPollIntervalMs();
	pollTimer = setInterval(() => pollOnce(), intervalMs);
	log.info('github-pr-poller', `started (interval: ${intervalMs}ms, concurrency: ${getConcurrency()})`);

	// Immediate first poll
	setTimeout(() => pollOnce(), 0);
}

export function stop(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
		log.info('github-pr-poller', 'stopped');
	}
}

export function isRunning(): boolean {
	return pollTimer !== null;
}

/** Reset internal state for testing. */
export function _resetForTesting(): void {
	isPolling = false;
}
