/**
 * Prompt builders for autonomous job execution.
 * Each prompt type injects JOB_ID + CALLBACK_URL metadata so the
 * job-callback extension can report results back.
 *
 * When PI_JOB_TASK_SKILL, PI_JOB_LOOP_TASK_SKILL, or PI_JOB_REVIEW_SKILL
 * env vars are set, the prompts invoke the named skill. Otherwise the agent
 * receives only the bare task context and output markers — it decides how
 * to approach the work using its own system prompt and tools.
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
	].join('\n');
}

/** Build the common task context lines (title, description, issue, branch). */
function taskContext(job: Job): string[] {
	const lines: string[] = [];
	lines.push(job.title);
	if (job.description) lines.push(job.description);
	if (job.issue_url) lines.push(`Issue: ${job.issue_url}`);
	if (job.branch) lines.push(`Branch: ${job.branch}`);
	if (job.target_branch) lines.push(`Target branch: ${job.target_branch}`);
	return lines;
}

// --- Task prompt ---

export function buildTaskPrompt(job: Job): string {
	const header = metadataHeader(job);
	const skill = job.max_loops === 0 ? TASK_SKILL : LOOP_TASK_SKILL;
	const context = taskContext(job);
	const parts = [header, ''];

	if (skill) {
		parts.push(`/skill:${skill} ${context.join('\n')}`);
	} else {
		parts.push(...context);
	}

	parts.push('');
	parts.push('=== CRITICAL: REQUIRED OUTPUT ===');
	parts.push('When you are completely done, you MUST output this exact line as the VERY LAST thing in your response:');
	parts.push('');
	parts.push('PR_URL: <the full PR URL>');
	parts.push('');
	parts.push('This is a machine-parsed marker. The job cannot proceed without it.');
	parts.push('Do NOT paraphrase, reword, or wrap it in a code block. Output the exact line on its own.');
	parts.push('=================================');

	return parts.join('\n');
}

// --- Fix prompt (sent after review requests changes) ---

export function buildTaskFixPrompt(job: Job, _reviewComments: string): string {
	const header = metadataHeader(job);
	const parts = [header, ''];

	parts.push(`Fix the review comments above. (Loop ${job.loop_count}/${job.max_loops})`);
	if (job.pr_url) parts.push(`PR: ${job.pr_url}`);

	parts.push('');
	parts.push('=== CRITICAL: REQUIRED OUTPUT ===');
	parts.push('When you are completely done, you MUST output this exact line as the VERY LAST thing in your response:');
	parts.push('');
	parts.push('PR_URL: <the full PR URL>');
	parts.push('');
	parts.push('This is a machine-parsed marker. The job cannot proceed without it.');
	parts.push('Do NOT paraphrase, reword, or wrap it in a code block. Output the exact line on its own.');
	parts.push('=================================');

	return parts.join('\n');
}

// --- Review prompt ---

export function buildReviewPrompt(job: Job): string {
	const header = metadataHeader(job);
	const parts = [header, ''];

	if (REVIEW_SKILL) {
		const context: string[] = [];
		context.push(`Review: ${job.title}`);
		context.push(`Loop ${job.loop_count}/${job.max_loops}`);
		if (job.pr_url) context.push(`PR: ${job.pr_url}`);
		if (job.branch) context.push(`Branch: ${job.branch}`);
		if (job.target_branch) context.push(`Target branch: ${job.target_branch}`);

		parts.push(`/skill:${REVIEW_SKILL} ${context.join('\n')}`);
	} else {
		parts.push(`Review the changes for: ${job.title}`);
		parts.push(`Loop ${job.loop_count}/${job.max_loops}`);
		if (job.pr_url) parts.push(`PR: ${job.pr_url}`);
	}

	parts.push('');
	parts.push('=== CRITICAL: REQUIRED OUTPUT ===');
	parts.push('After completing the review, you MUST output EXACTLY one of these two lines as the VERY LAST thing in your response:');
	parts.push('');
	parts.push('VERDICT: approved');
	parts.push('VERDICT: changes_requested');
	parts.push('');
	parts.push('This is a machine-parsed marker. The job will FAIL if you do not include it.');
	parts.push('Do NOT paraphrase, reword, or wrap it in a code block. Output the exact line on its own.');
	parts.push('=================================');

	return parts.join('\n');
}
