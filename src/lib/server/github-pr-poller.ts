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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb } from './cache';
import { createJob, findActiveJobByPrUrl } from './job-queue';
import { REVIEW_SKILL } from './job-prompts';
import { log } from './logger';

// --- Constants ---

const DEFAULT_POLL_INTERVAL_SECONDS = 600;
const DEFAULT_CONCURRENCY = 5;
const GH_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

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
export async function getGitHubUser(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			'gh', ['api', 'user', '--jq', '.login'],
			{ timeout: GH_TIMEOUT_MS, encoding: 'utf-8' },
		);
		return stdout.trim() || null;
	} catch (err) {
		log.warn('github-pr-poller', `failed to get GitHub user: ${err}`);
		return null;
	}
}

/**
 * List open PRs for a given repo. Optionally filter by assignee.
 */
export async function listOpenPrs(owner: string, name: string, assignee?: string): Promise<GitHubPr[]> {
	try {
		const args = [
			'pr', 'list',
			'--repo', `${owner}/${name}`,
			'--state', 'open',
			'--json', 'number,title,headRefName,baseRefName,url',
			'--limit', '30',
		];

		if (assignee) {
			args.push('--assignee', assignee);
		}

		const { stdout } = await execFileAsync('gh', args, {
			timeout: GH_TIMEOUT_MS,
			encoding: 'utf-8',
		});

		return JSON.parse(stdout) as GitHubPr[];
	} catch (err) {
		log.warn('github-pr-poller', `failed to list PRs for ${owner}/${name}: ${err}`);
		return [];
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
	const ghUser = await getGitHubUser();
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
			prs = await listOpenPrs(repo.owner, repo.name, assignee);
		} catch (err) {
			log.error('github-pr-poller', `error listing PRs for ${repo.owner}/${repo.name}: ${err}`);
			result.errors++;
			continue;
		}

		for (const pr of prs) {
			// Re-check concurrency for each PR
			if (countActiveJobs() >= concurrency) {
				log.info('github-pr-poller', `concurrency limit reached — stopping PR processing`);
				break;
			}

			const prUrl = pr.url;

			// Skip if there's already an active job for this PR
			const existing = findActiveJobByPrUrl(prUrl);
			if (existing) {
				log.info('github-pr-poller', `skipping ${repo.owner}/${repo.name}#${pr.number} — active job exists (${existing.status})`);
				result.skipped++;
				continue;
			}

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
				});

				log.info('github-pr-poller', `created review job ${job.id} for ${repo.owner}/${repo.name}#${pr.number}`);
				result.created++;
			} catch (err) {
				log.error('github-pr-poller', `failed to create job for ${repo.owner}/${repo.name}#${pr.number}: ${err}`);
				result.errors++;
			}
		}
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

	const ghUser = await getGitHubUser();
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
			prs = await listOpenPrs(repo.owner, repo.name, assignee);
		} catch (err) {
			log.error('github-pr-poller', `error listing PRs for ${repo.owner}/${repo.name}: ${err}`);
			result.errors++;
			continue;
		}

		for (const pr of prs) {
			if (countActiveJobs() >= concurrency) {
				log.info('github-pr-poller', `concurrency limit reached — stopping PR processing`);
				break;
			}

			const prUrl = pr.url;
			const existing = findActiveJobByPrUrl(prUrl);
			if (existing) {
				result.skipped++;
				continue;
			}

			try {
				createJob({
					type: 'review',
					title: pr.title || `PR #${pr.number}`,
					repo: repo.local_path ?? undefined,
					branch: pr.headRefName,
					target_branch: pr.baseRefName,
					pr_url: prUrl,
					review_skill: REVIEW_SKILL || undefined,
				});
				result.created++;
			} catch (err) {
				result.errors++;
			}
		}
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
