/**
 * GET /api/jobs — List jobs with optional filters
 * POST /api/jobs — Create a new job
 *
 * Review jobs can omit the title — it's inferred from the PR URL via `gh` CLI.
 */
import { json, error } from '@sveltejs/kit';
import { getJobs, createJob, findActiveJobByPrUrl, findActiveJobByIssueUrl } from '$lib/server/job-queue';
import { fetchPrMetadata, fallbackTitle } from '$lib/server/pr-metadata';
import { fetchIssueMetadata, fallbackIssueTitle } from '$lib/server/issue-metadata';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') ?? undefined;
	const type = url.searchParams.get('type') ?? undefined;
	const repo = url.searchParams.get('repo') ?? undefined;

	const jobs = getJobs({ status, type, repo });
	return json({ jobs });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { type, title, description, repo, branch, issue_url, target_branch, priority, max_loops, pr_url, review_skill, model, harness } = body;

		// Type is now optional (defaults to 'task' in createJob)
		if (type && !['task', 'review'].includes(type)) {
			throw error(400, 'Invalid job type — must be "task" or "review" (or omitted)');
		}

		const isReview = type === 'review';
		const trimmedPrUrl = pr_url?.trim() || undefined;
		const trimmedIssueUrl = issue_url?.trim() || undefined;
		let resolvedTitle = title?.trim() || undefined;
		let resolvedDescription = description?.trim() || undefined;
		let resolvedBranch = branch?.trim() || undefined;
		let resolvedTargetBranch = target_branch?.trim() || undefined;

		// Review jobs: infer title/branch/target from PR metadata when not provided
		if (isReview && trimmedPrUrl) {
			const meta = fetchPrMetadata(trimmedPrUrl);
			if (meta) {
				if (!resolvedTitle) resolvedTitle = meta.title;
				if (!resolvedBranch) resolvedBranch = meta.branch;
				if (!resolvedTargetBranch) resolvedTargetBranch = meta.targetBranch;
			} else if (!resolvedTitle) {
				// gh unavailable — use PR number as fallback title
				resolvedTitle = fallbackTitle(trimmedPrUrl);
			}
		}

		// Infer title/description from issue URL when not provided
		if (trimmedIssueUrl && (!resolvedTitle || !resolvedDescription)) {
			const issueMeta = fetchIssueMetadata(trimmedIssueUrl);
			if (issueMeta) {
				if (!resolvedTitle) resolvedTitle = issueMeta.title;
				if (!resolvedDescription) resolvedDescription = issueMeta.description || undefined;
			} else if (!resolvedTitle) {
				resolvedTitle = fallbackIssueTitle(trimmedIssueUrl);
			}
		}

		// Title is required for non-review jobs; review jobs must have a PR URL at minimum
		if (isReview && !trimmedPrUrl) {
			throw error(400, 'PR URL is required for review jobs');
		}
		if (!resolvedTitle) {
			throw error(400, 'Title is required');
		}

		// Deduplicate: reject if an active job already exists for the same PR or issue URL
		if (trimmedPrUrl) {
			const existing = findActiveJobByPrUrl(trimmedPrUrl);
			if (existing) {
				throw error(409, `An active job already exists for this PR (${existing.status}): ${existing.title}`);
			}
		}
		if (trimmedIssueUrl) {
			const existing = findActiveJobByIssueUrl(trimmedIssueUrl);
			if (existing) {
				throw error(409, `An active job already exists for this issue (${existing.status}): ${existing.title}`);
			}
		}

		const job = createJob({
			type: type || undefined, // Let createJob apply default
			title: resolvedTitle,
			description: resolvedDescription,
			repo: repo?.trim() || undefined,
			branch: resolvedBranch,
			issue_url: issue_url?.trim() || undefined,
			target_branch: resolvedTargetBranch,
			priority: typeof priority === 'number' ? priority : undefined,
			max_loops: typeof max_loops === 'number' ? max_loops : undefined,
			pr_url: trimmedPrUrl,
			review_skill: review_skill?.trim() || undefined,
			model: model?.trim() || undefined,
			harness: harness || undefined,
		});

		return json({ job }, { status: 201 });
	} catch (e: any) {
		if (e.status) throw e;
		throw error(500, `Failed to create job: ${e.message || e}`);
	}
};
