/**
 * Prompt builders for autonomous job execution.
 * Each prompt type injects JOB_ID + CALLBACK_URL metadata so the
 * job-callback extension can report results back.
 */
import type { Job } from './job-queue';

const DEFAULT_HOST = process.env.PI_REMOTE_HOST || 'http://localhost:5173';

// --- Metadata header injected at the top of every job prompt ---

function metadataHeader(job: Job): string {
	const callbackUrl = `${DEFAULT_HOST}/api/jobs/${job.id}/complete`;
	return [
		`JOB_ID: ${job.id}`,
		`CALLBACK_URL: ${callbackUrl}`,
		`CALLBACK_TOKEN: ${job.callback_token}`,
		'',
	].join('\n');
}

// --- Task prompt: new work ---

export function buildTaskPrompt(job: Job): string {
	const header = metadataHeader(job);
	const parts = [header];

	parts.push(`# Task: ${job.title}`);
	parts.push('');

	if (job.description) {
		parts.push(job.description);
		parts.push('');
	}

	if (job.issue_url) {
		parts.push(`Issue: ${job.issue_url}`);
		parts.push('');
	}

	if (job.branch) {
		parts.push(`Work on branch: ${job.branch}`);
	} else {
		parts.push('Create a feature branch from the target branch for this work.');
	}

	if (job.target_branch) {
		parts.push(`Target branch: ${job.target_branch}`);
	}

	parts.push('');
	parts.push('When finished, create a pull request and output exactly:');
	parts.push('PR_URL: <the full PR URL>');
	parts.push('');
	parts.push('Commit with conventional commits. Run tests and typecheck before pushing.');

	return parts.join('\n');
}

// --- Task prompt: fix review comments ---

export function buildTaskFixPrompt(job: Job, reviewComments: string): string {
	const header = metadataHeader(job);
	const parts = [header];

	parts.push(`# Fix Review Comments: ${job.title}`);
	parts.push('');
	parts.push(`This is loop iteration ${job.loop_count} of ${job.max_loops}.`);
	parts.push('');

	if (job.pr_url) {
		parts.push(`Existing PR: ${job.pr_url}`);
		parts.push('');
	}

	if (job.branch) {
		parts.push(`Branch: ${job.branch}`);
		parts.push('');
	}

	parts.push('## Review Feedback');
	parts.push('');
	parts.push(reviewComments);
	parts.push('');
	parts.push('Address all the review comments above. Push the fixes to the existing branch.');
	parts.push('Run tests and typecheck before pushing.');
	parts.push('');
	parts.push('When finished, output exactly:');
	parts.push('PR_URL: <the full PR URL>');

	return parts.join('\n');
}

// --- Review prompt ---

export function buildReviewPrompt(job: Job): string {
	const header = metadataHeader(job);
	const parts = [header];

	parts.push(`# Review: ${job.title}`);
	parts.push('');
	parts.push(`This is loop iteration ${job.loop_count} of ${job.max_loops}.`);
	parts.push('');

	if (job.pr_url) {
		parts.push(`PR to review: ${job.pr_url}`);
		parts.push('');
	}

	if (job.branch) {
		parts.push(`Branch: ${job.branch}`);
	}

	if (job.target_branch) {
		parts.push(`Target branch: ${job.target_branch}`);
	}

	parts.push('');
	parts.push('Review the changes in the PR thoroughly. Check for:');
	parts.push('- Correctness and logic errors');
	parts.push('- Test coverage');
	parts.push('- Code style and conventions');
	parts.push('- Security concerns');
	parts.push('- Performance issues');
	parts.push('');
	parts.push('When finished, output exactly one of:');
	parts.push('VERDICT: approved');
	parts.push('VERDICT: changes_requested');
	parts.push('');
	parts.push('If changes are requested, provide detailed feedback explaining what needs to be fixed.');

	return parts.join('\n');
}
