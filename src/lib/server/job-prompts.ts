/**
 * Prompt builders for autonomous job execution.
 * Each prompt type injects JOB_ID + CALLBACK_URL metadata so the
 * job-callback extension can report results back.
 *
 * When PI_JOB_TASK_SKILL or PI_JOB_LOOP_TASK_SKILL env vars are set,
 * the prompts invoke the named skill. Otherwise the agent receives only
 * the bare task context and output markers — it decides how to approach
 * the work using its own system prompt and tools.
 *
 * Review prompts are enhanced by an optional PrAnalysis from pr-analysis.ts
 * which tailors the review focus to the PR's stack and nature of changes.
 */
import type { Job } from './job-queue';
import type { PrAnalysis } from './pr-analysis';

// --- Skill configuration from environment ---

/** Skill for fire-and-forget tasks (max_loops=0). e.g. 'issue-worker' */
export const TASK_SKILL = process.env.PI_JOB_TASK_SKILL || '';
/** Skill for the task/fix phase inside a review loop (max_loops>0). e.g. 'issue-worker' */
export const LOOP_TASK_SKILL = process.env.PI_JOB_LOOP_TASK_SKILL || '';

// --- Metadata header injected at the top of every job prompt ---

function metadataHeader(_job: Job): string {
	// Job completion is now handled server-side in rpc-manager (agent_end → findJobBySessionId).
	// No callback metadata needed in the prompt.
	return '';
}

/** Build the common task context lines (title, description, issue, branch). */
function taskContext(job: Job): string[] {
	const lines: string[] = [];
	lines.push(job.title);
	if (job.description) lines.push(job.description);
	if (job.issue_url) lines.push(`Issue: ${job.issue_url}`);
	if (job.branch) lines.push(`Branch: ${job.branch}`);
	if (job.target_branch) lines.push(`Target branch: ${job.target_branch}`);
	lines.push(`Job ID: ${job.id}`);
	return lines;
}

// --- Task prompt ---

export function buildTaskPrompt(job: Job, harness: string = 'pi'): string {
	const header = metadataHeader(job);
	const skill = job.max_loops === 0 ? TASK_SKILL : LOOP_TASK_SKILL;
	const context = taskContext(job);
	const parts = [header, ''];

	if (skill && harness === 'pi') {
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

// --- Nudge verdict prompt (sent when agent ends without a VERDICT) ---

export function buildNudgeVerdictPrompt(job: Job, attempt: number): string {
	const parts: string[] = [];

	parts.push(`You stopped without providing a VERDICT. This is attempt ${attempt} of ${job.max_no_verdict_retries}.`);
	parts.push('');
	parts.push('If you are stalled or have finished your review, please provide your verdict now.');
	parts.push('If you have not finished, continue your work and then provide the verdict.');
	parts.push('');
	parts.push('=== CRITICAL: REQUIRED OUTPUT ===');
	parts.push('You MUST output EXACTLY one of these lines as the VERY LAST thing in your response:');
	parts.push('');
	parts.push('VERDICT: approved');
	parts.push('VERDICT: changes_requested');
	parts.push('');
	parts.push('If you cannot complete this job due to an unrecoverable error (e.g. the issue,');
	parts.push('repo, or PR does not exist, or you lack the information needed to proceed),');
	parts.push('output this instead:');
	parts.push('');
	parts.push('ABORT_JOB: <reason>');
	parts.push('');
	parts.push('These are machine-parsed markers. The job will FAIL if you do not include one.');
	parts.push('Do NOT paraphrase, reword, or wrap it in a code block. Output the exact line on its own.');
	parts.push('=================================');

	return parts.join('\n');
}

// --- Review prompt ---

export function buildReviewPrompt(job: Job, _harness: string = 'pi', analysis?: PrAnalysis): string {
	const header = metadataHeader(job);
	const parts = [header, ''];

	// When analysis is available, prepend tailored review instructions
	if (analysis) {
		parts.push(analysis.reviewPrompt);
		parts.push('');
		parts.push('---');
		parts.push('');
	}

	parts.push(`Review the changes for: ${job.title}`);
	parts.push(`Loop ${job.loop_count}/${job.max_loops}`);
	if (job.pr_url) parts.push(`PR: ${job.pr_url}`);

	parts.push('');
	parts.push('=== PR CONVERSATION CONTEXT ===');
	parts.push('Before finalizing your review, read through the existing PR comments and conversation.');
	parts.push('Pay close attention to messages that directly address or respond to previously raised issues.');
	parts.push('If an issue from a prior review has been acknowledged, explained, or resolved in the');
	parts.push('conversation, do NOT re-raise it unless the response is insufficient or the fix is incorrect.');
	parts.push('Your review should focus on the current state of the code and any unresolved concerns.');
	parts.push('================================');
	parts.push('');
	parts.push('=== CRITICAL: REQUIRED STEPS ===');
	parts.push('After completing the review, you MUST do BOTH of these steps IN ORDER:');
	parts.push('');
	parts.push('1. SUBMIT the review to GitHub using gh pr review:');
	parts.push('   - Approve: gh pr review <number> --approve --body "your review summary"');
	parts.push('   - Request changes: gh pr review <number> --request-changes --body "your review summary"');
	parts.push('   Include your review summary (strengths, issues, suggestions) in the --body.');
	parts.push('   Do NOT skip this step. The review MUST be visible on the GitHub PR.');
	parts.push('');
	parts.push('2. Check that the gh pr review command succeeded. ONLY if it succeeded,');
	parts.push('   output EXACTLY one of these two lines as the VERY LAST thing in your response:');
	parts.push('');
	parts.push('VERDICT: approved');
	parts.push('VERDICT: changes_requested');
	parts.push('');
	parts.push('If the gh pr review command FAILED (non-zero exit, error output, permission denied),');
	parts.push('do NOT output a VERDICT line. Instead output:');
	parts.push('');
	parts.push('REVIEW_SUBMIT_FAILED: <reason>');
	parts.push('');
	parts.push('These are machine-parsed markers. Do NOT paraphrase, reword, or wrap in a code block.');
	parts.push('=================================');

	return parts.join('\n');
}
