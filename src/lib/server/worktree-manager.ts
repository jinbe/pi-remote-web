/**
 * Worktree lifecycle: parallelism units backed by real `git worktree` checkouts.
 *
 * Each worktree owns a serial queue of tasks. Tasks within a worktree run in
 * creation order; tasks across worktrees run in parallel. Worktree dirs live
 * sibling to the repo at `<repo>-worktrees/<slug>/`.
 */
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { getDb } from './cache';
import { log } from './logger';
import { notify } from './push';

// --- Types ---

export interface Worktree {
	id: string;
	repo: string;
	dir_path: string;
	base_branch: string;
	slug: string;
	status: 'active' | 'paused' | 'halted' | 'closed';
	halt_reason: string | null;
	external_loop_cap: number;
	internal_loop_cap: number;
	auto_merge: number;
	created_at: string;
	closed_at: string | null;
	last_activity_at: string;
}

export interface CreateWorktreeInput {
	repo: string;
	first_task_title?: string;
	base_branch?: string;
	slug?: string;
}

// --- Slug helpers ---

/**
 * Build a kebab-case slug from a title, truncated to 32 chars, with a 4-char
 * random suffix to disambiguate between worktrees with similar titles.
 */
export function buildSlug(title: string | undefined): string {
	const base = (title ?? 'untitled')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32) || 'untitled';
	const suffix = Math.random().toString(16).slice(2, 6);
	return `${base}-${suffix}`;
}

/**
 * Derive the worktrees-parent directory for a given repo.
 * Repo `/Users/jchan/code/pi-remote-web` → `/Users/jchan/code/pi-remote-web-worktrees`.
 */
export function worktreesParentDir(repoPath: string): string {
	const parent = dirname(repoPath);
	const repoName = basename(repoPath);
	return join(parent, `${repoName}-worktrees`);
}

// --- Git helpers ---

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args[0]} (cwd=${cwd}) exited ${exitCode}: ${stderr.trim()}`);
	}
	return stdout.trim();
}

// --- Public API ---

/**
 * Create a worktree row AND materialise the on-disk `git worktree`.
 *
 * Eager materialisation: the planning agent needs to read files in the worktree
 * during the grill-me chat, so the dir must exist before the first task starts.
 *
 * Throws if the repo path doesn't exist, isn't a git repo, or `git worktree add` fails.
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
	if (!existsSync(input.repo)) {
		throw new Error(`Repo path does not exist: ${input.repo}`);
	}
	if (!existsSync(join(input.repo, '.git'))) {
		throw new Error(`Not a git repo: ${input.repo}`);
	}

	const slug = input.slug ?? buildSlug(input.first_task_title);
	const baseBranch = input.base_branch ?? 'main';
	const parentDir = worktreesParentDir(input.repo);
	const dirPath = join(parentDir, slug);

	if (existsSync(dirPath)) {
		throw new Error(`Worktree dir already exists: ${dirPath}`);
	}

	if (!existsSync(parentDir)) {
		mkdirSync(parentDir, { recursive: true });
	}

	// Pull latest on the source repo's base branch so the new worktree starts current.
	// Best-effort: if the repo isn't on `baseBranch` or pull fails (offline, conflicts),
	// fall back to whatever the base ref points to locally.
	try {
		await runGit(input.repo, ['fetch', 'origin', baseBranch]);
	} catch (err) {
		log.warn('worktree-manager', `fetch origin ${baseBranch} failed for ${input.repo}: ${err}`);
	}

	// Create the worktree at HEAD of origin/<baseBranch> (falls back to local <baseBranch>
	// if origin ref is unavailable). Detached so the worktree itself isn't on a branch —
	// each task will create its own feature branch from this point.
	const baseRef = await resolveBaseRef(input.repo, baseBranch);
	await runGit(input.repo, ['worktree', 'add', '--detach', dirPath, baseRef]);

	const row = getDb().query(`
		INSERT INTO worktrees (repo, dir_path, base_branch, slug)
		VALUES ($repo, $dir_path, $base_branch, $slug)
		RETURNING *
	`).get({
		$repo: input.repo,
		$dir_path: dirPath,
		$base_branch: baseBranch,
		$slug: slug,
	}) as Worktree;

	log.info('worktree-manager', `created worktree ${row.id} (${slug}) at ${dirPath}`);
	return row;
}

async function resolveBaseRef(repo: string, baseBranch: string): Promise<string> {
	try {
		await runGit(repo, ['rev-parse', '--verify', `origin/${baseBranch}`]);
		return `origin/${baseBranch}`;
	} catch {
		return baseBranch;
	}
}

/**
 * Close a worktree: remove the on-disk dir via `git worktree remove`, mark closed in db.
 * Tasks inside are not deleted — they remain as historical rows.
 *
 * Throws if any task in the worktree is in an active stage (planning/dev/internal_review/
 * external_review/awaiting_merge). Caller must cancel or wait for tasks first.
 */
export async function closeWorktree(id: string, force = false): Promise<Worktree | null> {
	const wt = getWorktree(id);
	if (!wt) return null;
	if (wt.status === 'closed') return wt;

	if (!force) {
		const active = countActiveTasks(id);
		if (active > 0) {
			throw new Error(`Cannot close worktree ${id} — ${active} task(s) still active. Cancel them or pass force=true.`);
		}
	}

	if (existsSync(wt.dir_path)) {
		try {
			await runGit(wt.repo, ['worktree', 'remove', '--force', wt.dir_path]);
		} catch (err) {
			log.warn('worktree-manager', `git worktree remove failed for ${wt.dir_path}: ${err}`);
		}
	}

	const row = getDb().query(`
		UPDATE worktrees SET status = 'closed', closed_at = datetime('now')
		WHERE id = ? RETURNING *
	`).get(id) as Worktree | null;
	log.info('worktree-manager', `closed worktree ${id}`);
	return row;
}

/**
 * Advance a worktree's checkout after a task PR merges: pull the base branch and
 * reset the worktree to its tip, ready for the next task's dev stage to branch off.
 *
 * Returns the new base SHA on success. Idempotent — safe to call multiple times.
 */
export async function advanceWorktree(id: string): Promise<string | null> {
	const wt = getWorktree(id);
	if (!wt) return null;
	if (wt.status !== 'active') {
		log.info('worktree-manager', `skipping advance for worktree ${id} — status is ${wt.status}`);
		return null;
	}
	if (!existsSync(wt.dir_path)) {
		throw new Error(`Worktree dir missing: ${wt.dir_path}`);
	}

	await runGit(wt.dir_path, ['fetch', 'origin', wt.base_branch]);
	const baseRef = await resolveBaseRef(wt.dir_path, wt.base_branch);
	await runGit(wt.dir_path, ['checkout', '--detach', baseRef]);
	const sha = await runGit(wt.dir_path, ['rev-parse', 'HEAD']);

	getDb().run(
		`UPDATE worktrees SET last_activity_at = datetime('now') WHERE id = ?`,
		[id],
	);
	log.info('worktree-manager', `advanced worktree ${id} to ${baseRef} (${sha.slice(0, 8)})`);
	return sha;
}

/**
 * Mark a worktree as halted with a reason. Used by the failure-cascade path
 * when any task in the worktree fails. UI surfaces the reason; user must
 * resolve before tasks continue.
 */
export function haltWorktree(id: string, reason: string): Worktree | null {
	const row = getDb().query(`
		UPDATE worktrees SET status = 'halted', halt_reason = ?, last_activity_at = datetime('now')
		WHERE id = ? AND status = 'active' RETURNING *
	`).get(reason, id) as Worktree | null;
	if (row) {
		log.warn('worktree-manager', `halted worktree ${id}: ${reason}`);
		notify({
			title: `Worktree halted: ${row.slug}`,
			body: reason,
			url: '/worktrees',
			tag: `halt:${row.id}`,
		}).catch(() => {});
	}
	return row;
}

/** Resume a halted worktree by clearing the halt_reason. */
export function resumeWorktree(id: string): Worktree | null {
	return getDb().query(`
		UPDATE worktrees SET status = 'active', halt_reason = NULL, last_activity_at = datetime('now')
		WHERE id = ? AND status = 'halted' RETURNING *
	`).get(id) as Worktree | null;
}

export function getWorktree(id: string): Worktree | null {
	return getDb().query('SELECT * FROM worktrees WHERE id = ?').get(id) as Worktree | null;
}

export function listWorktrees(filter?: { status?: Worktree['status']; repo?: string }): Worktree[] {
	const conditions: string[] = [];
	const params: Record<string, any> = {};
	if (filter?.status) { conditions.push('status = $status'); params.$status = filter.status; }
	if (filter?.repo) { conditions.push('repo = $repo'); params.$repo = filter.repo; }
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	return getDb().query(
		`SELECT * FROM worktrees ${where} ORDER BY last_activity_at DESC`,
	).all(params) as Worktree[];
}

/**
 * Count tasks in stages that are still active (not done/failed/cancelled).
 * Used by closeWorktree to refuse closure when work is in flight.
 */
export function countActiveTasks(worktreeId: string): number {
	const row = getDb().query(`
		SELECT COUNT(*) AS n FROM tasks
		WHERE worktree_id = ? AND stage NOT IN ('done', 'failed', 'cancelled')
	`).get(worktreeId) as { n: number };
	return row.n;
}

/**
 * Predicate: is a worktree's queue ready for the next task to enter the dev stage?
 *
 * The gate (per design Q4: dev-only): the most-recent task that entered dev must
 * have its PR merged. Returns:
 *   - { ready: true } if no tasks in the worktree have entered dev, OR the latest
 *     such task has stage='done'.
 *   - { ready: false, blockedBy: <task_id> } otherwise.
 */
export function devGate(worktreeId: string): { ready: true } | { ready: false; blockedBy: string; reason: string } {
	const wt = getWorktree(worktreeId);
	if (!wt) return { ready: false, blockedBy: '', reason: `worktree ${worktreeId} not found` };
	if (wt.status !== 'active') {
		return { ready: false, blockedBy: '', reason: `worktree status is ${wt.status}` };
	}

	// Find the most-recent task that has entered dev (or beyond) but is not yet done.
	const blocker = getDb().query(`
		SELECT id, stage FROM tasks
		WHERE worktree_id = ?
		  AND stage IN ('dev', 'internal_review', 'external_review', 'awaiting_merge')
		ORDER BY position DESC LIMIT 1
	`).get(worktreeId) as { id: string; stage: string } | null;

	if (!blocker) return { ready: true };
	return { ready: false, blockedBy: blocker.id, reason: `task ${blocker.id} in stage ${blocker.stage}` };
}

/**
 * Get the next task in a worktree that's ready to advance to dev.
 * Returns null if no task is queued, or if the gate is closed.
 */
export function nextTaskReadyForDev(worktreeId: string): { task_id: string } | null {
	const gate = devGate(worktreeId);
	if (!gate.ready) return null;

	const row = getDb().query(`
		SELECT id FROM tasks
		WHERE worktree_id = ? AND stage = 'queued'
		ORDER BY position ASC LIMIT 1
	`).get(worktreeId) as { id: string } | null;
	return row ? { task_id: row.id } : null;
}
