/**
 * Prompt builders for autonomous job execution.
 * Each prompt type injects JOB_ID + CALLBACK_URL metadata so the
 * job-callback extension can report results back.
 *
 * When PI_JOB_TASK_SKILL or PI_JOB_REVIEW_SKILL env vars are set,
 * the prompts invoke the named skill instead of using hardcoded instructions.
 */
import type { Job } from './job-queue';
import { getOrigin } from './origin';

// --- Skill configuration from environment ---

/** Skill for fire-and-forget tasks (max_loops=0). e.g. 'issue-worker' */
export const TASK_SKILL = process.env.PI_JOB_TASK_SKILL || '';
/** Skill for the task/fix phase inside a review loop (max_loops>0). e.g. 'issue-worker' */
export const LOOP_TASK_SKILL = process.env.PI_JOB_LOOP_TASK_SKILL || '';
/** Skill for the review phase inside a review loop. e.g. 'review' */
export const REVIEW_SKILL = process.env.PI_JOB_REVIEW_SKILL || '';

// --- Metadata header injected at the top of every job prompt ---

function metadataHeader(job: Job): string {
	const callbackUrl = `${getOrigin()}/api/jobs/${job.id}/complete`;
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

	// Pick the right skill: fire-and-forget vs loop task phase
	const skill = job.max_loops === 0 ? TASK_SKILL : LOOP_TASK_SKILL;
	if (skill) {
		return buildSkillTaskPrompt(job, header, skill);
	}

	// Fallback: hardcoded task prompt
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

// --- Skill-based task prompt ---

function buildSkillTaskPrompt(job: Job, header: string, skill: string): string {
	const parts = [header];

	// Build the task context for the skill
	const context: string[] = [];
	context.push(job.title);
	if (job.description) context.push(job.description);
	if (job.issue_url) context.push(`Issue: ${job.issue_url}`);
	if (job.branch) context.push(`Branch: ${job.branch}`);
	if (job.target_branch) context.push(`Target branch: ${job.target_branch}`);

	parts.push(`/skill:${skill} ${context.join('\n')}`);
	parts.push('');
	parts.push('When done, output exactly:');
	parts.push('PR_URL: <the full PR URL>');

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

	parts.push('The review comments are in the conversation above. Address all the feedback.');
	parts.push('');
	parts.push('Push the fixes to the existing branch.');
	parts.push('Run tests and typecheck before pushing.');
	parts.push('');
	parts.push('When finished, output exactly:');
	parts.push('PR_URL: <the full PR URL>');

	return parts.join('\n');
}

// --- Review prompt ---

export function buildReviewPrompt(job: Job): string {
	const header = metadataHeader(job);

	// If a review skill is configured, invoke it
	if (REVIEW_SKILL) {
		return buildSkillReviewPrompt(job, header);
	}

	// Fallback: hardcoded review prompt
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
	parts.push('Review the changes you just made. You have full context of the code in this session.');
	parts.push('');
	parts.push('Check for:');
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

// --- Skill-based review prompt ---

function buildSkillReviewPrompt(job: Job, header: string): string {
	const parts = [header];

	const context: string[] = [];
	context.push(`Review: ${job.title}`);
	context.push(`Loop iteration ${job.loop_count} of ${job.max_loops}`);
	if (job.pr_url) context.push(`PR: ${job.pr_url}`);
	if (job.branch) context.push(`Branch: ${job.branch}`);
	if (job.target_branch) context.push(`Target branch: ${job.target_branch}`);

	parts.push(`/skill:${REVIEW_SKILL} ${context.join('\n')}`);
	parts.push('');
	parts.push('When finished, output exactly one of:');
	parts.push('VERDICT: approved');
	parts.push('VERDICT: changes_requested');
	parts.push('');
	parts.push('If changes are requested, provide detailed feedback.');

	return parts.join('\n');
}
