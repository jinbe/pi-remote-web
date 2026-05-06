/**
 * Prompt builders for task-system stages: planning, dev, internal_review,
 * external_review_fix, triage. Each prompt embeds machine-parsed output markers
 * the job-poller's transition handler reads to advance the task's stage.
 *
 * Legacy job prompts in `job-prompts.ts` continue to serve orphan jobs (task_id IS NULL).
 */
import type { Task } from './task-queue';
import type { Worktree } from './worktree-manager';

// --- Output marker grammar ---
//
// BRANCH_PUSHED: <branch>           dev → internal_review trigger
// VERDICT: approved | changes_requested  internal_review verdict
// PR_URL: <url>                     internal_review approved → opens PR
// FIX_PUSHED: <sha>                 external_review_fix → re-poll trigger
// TRIAGE_PLAN: <json-block>         triage → awaiting_merge
// ABORT_TASK: <reason>              any stage agent gives up, halts task
//
// Markers must appear as the VERY LAST line(s) of the agent's output.

// --- Shared header ---

function header(task: Task, worktree: Worktree, stage: string): string[] {
	return [
		`Task: ${task.title}`,
		`Worktree: ${worktree.slug} (${worktree.repo})`,
		`Base branch: ${worktree.base_branch}`,
		`Stage: ${stage}`,
		`Task ID: ${task.id}`,
	];
}

function abortClause(): string[] {
	return [
		'',
		'If you cannot complete this stage due to an unrecoverable error',
		'(missing repo, broken tooling, malformed task description),',
		'output this line instead of the stage marker:',
		'',
		'ABORT_TASK: <reason>',
	];
}

// --- Planning prompt ---

export interface UpstreamContext {
	task_id: string;
	title: string;
	description: string | null;
	pr_url: string | null;
	stage: string;
}

/**
 * Interactive planning. The agent acts as a Socratic interviewer driving the user
 * toward a complete task description. The session is long-lived; the user accepts
 * the final description via the dashboard "accept" action — no machine marker needed.
 *
 * Upstream context (descriptions + PR URLs of unmerged predecessor tasks in the
 * same worktree) is injected so the planner reasons against the FUTURE state of
 * the codebase, not just current main.
 */
export function buildPlanningPrompt(task: Task, worktree: Worktree, upstream: UpstreamContext[] = []): string {
	const lines = [
		...header(task, worktree, 'planning'),
		'',
		'You are running an interactive planning interview with the user. Your job is to',
		'produce a complete, unambiguous task description that a future dev agent could',
		'execute without further questions. The dev agent will read the final description',
		'as its full spec.',
		'',
		'You have shell access in the worktree dir. Read the codebase as needed to',
		'ground your questions in real file paths, function names, and existing patterns.',
		'',
		'Approach:',
		'  1. Ask the user one question at a time. Resolve each branch of the design tree',
		'     before moving on.',
		'  2. For each question, propose your recommended answer based on what you see',
		'     in the codebase. Make it easy for the user to confirm or push back.',
		'  3. When you reach shared understanding, draft the final task description as',
		'     a structured block with: goal, scope, files to touch, acceptance criteria.',
		'  4. The user will accept (or edit + accept) the description via the dashboard.',
		'     You do not need to emit a machine marker — completion is user-driven.',
		'',
		`Initial seed from the user: ${task.title}`,
	];

	if (task.description) {
		lines.push('', 'User-provided rough description:', task.description);
	}

	if (upstream.length > 0) {
		lines.push(
			'',
			'IMPORTANT — upstream context. The following tasks in this worktree are not',
			'yet merged but WILL be merged before this task starts dev. Plan against the',
			'codebase AS IT WILL BE after they land, not as it is right now.',
			'',
		);
		for (const u of upstream) {
			lines.push(`  • Task ${u.task_id} (stage=${u.stage}): ${u.title}`);
			if (u.description) lines.push(`    Description: ${u.description.split('\n')[0]}…`);
			if (u.pr_url) lines.push(`    PR: ${u.pr_url} — read this with \`gh pr diff\` for the actual changes.`);
		}
	}

	return lines.join('\n');
}

// --- Dev prompt ---

/**
 * Dev stage: implement the task in the worktree, push the feature branch, but do NOT
 * open a PR yet. PR creation happens after internal review approves.
 *
 * The branch name is generated from the worktree slug + task position. Agent commits
 * locally and pushes the branch to origin.
 */
export function buildDevPrompt(task: Task, worktree: Worktree, branchName: string): string {
	const lines = [
		...header(task, worktree, 'dev'),
		'',
		'You are the dev agent. Implement the task described below.',
		'',
		'Description (the planning stage produced this — treat it as your full spec):',
		'',
		task.description ?? '(no description — proceed only if title is self-explanatory)',
		'',
		'Workflow:',
		`  1. You are already in the worktree at ${worktree.dir_path}, detached from any branch.`,
		`  2. Create branch: git checkout -b ${branchName}`,
		'  3. Implement, commit (one or more commits, your choice).',
		`  4. Push: git push -u origin ${branchName}`,
		'  5. Do NOT open a PR. The internal review stage will do that after it approves.',
		'',
		'When the branch is pushed, output this exact line as the VERY LAST line:',
		'',
		`BRANCH_PUSHED: ${branchName}`,
		...abortClause(),
	];
	return lines.join('\n');
}

// --- Dev fix prompt (sent when internal review requests changes) ---

export function buildDevFixPrompt(task: Task, worktree: Worktree, reviewFeedback: string): string {
	const lines = [
		...header(task, worktree, 'dev (fix)'),
		'',
		`Internal review requested changes. Loop ${task.internal_loop_count + 1}.`,
		'',
		'Reviewer feedback:',
		'',
		reviewFeedback,
		'',
		'Workflow:',
		'  1. Address the feedback in additional commits on the same branch.',
		`  2. Push: git push (the branch ${task.branch ?? '<task branch>'} is already tracking).`,
		'  3. Do NOT open a PR yet.',
		'',
		'When pushed, output:',
		'',
		`BRANCH_PUSHED: ${task.branch ?? '<branch>'}`,
		...abortClause(),
	];
	return lines.join('\n');
}

// --- Internal review prompt ---

/**
 * Internal review reads the local diff against the worktree's base branch, decides
 * approval, and on APPROVE opens the PR via `gh pr create`. The PR is "ready for
 * external review" the moment it's visible (per design Q13:1).
 */
export function buildInternalReviewPrompt(task: Task, worktree: Worktree): string {
	const lines = [
		...header(task, worktree, 'internal_review'),
		'',
		'You are the internal review agent. Review the local diff (NOT a PR — the branch is',
		'pushed but no PR has been opened yet). On approval, you will open the PR.',
		'',
		`Diff command: git diff ${worktree.base_branch}...${task.branch ?? 'HEAD'}`,
		`Branch: ${task.branch ?? 'HEAD'}`,
		'',
		'Focus on the code itself: correctness, safety, missed edge cases, security,',
		'breaking changes. Do NOT block on PR description quality, comment style, or',
		'documentation outside the diff — those are out of scope here.',
		'',
		'Decision:',
		`  • APPROVE → run: gh pr create --base ${worktree.base_branch} --head ${task.branch ?? '<branch>'} --title "<task title>" --body "<summary>"`,
		'    capture the printed PR URL, then output VERDICT: approved followed by PR_URL.',
		'  • CHANGES_REQUESTED → write a clear list of what must change. Do NOT push commits;',
		'    the dev agent will pick up your feedback. Output VERDICT: changes_requested only.',
		'',
		'Output markers — the LAST lines of your response, in this exact order:',
		'',
		'On APPROVE:',
		'  VERDICT: approved',
		'  PR_URL: <full url>',
		'',
		'On CHANGES_REQUESTED:',
		'  VERDICT: changes_requested',
		...abortClause(),
	];
	return lines.join('\n');
}

// --- External review fix prompt ---

/**
 * External review (human) requested changes. Agent reads the unresolved review threads
 * via `gh pr view --json reviews,reviewThreads` (or equivalent), addresses them,
 * pushes new commits, and posts a "addressed in <sha>" reply to GitHub.
 */
export function buildExternalReviewFixPrompt(task: Task, worktree: Worktree, reviewerSummary: string): string {
	const lines = [
		...header(task, worktree, 'external_review_fix'),
		'',
		`A human reviewer requested changes. Loop ${task.external_loop_count + 1}.`,
		`PR: ${task.current_pr_url}`,
		'',
		'Reviewer summary (from the most recent CHANGES_REQUESTED review):',
		'',
		reviewerSummary,
		'',
		'Workflow:',
		`  1. Pull the unresolved review threads: gh pr view ${task.current_pr_number} --json reviewThreads,comments,reviews`,
		'  2. Read each thread. Identify which comments demand a code change vs. which',
		'     are questions you should reply to in-thread.',
		'  3. Address code-change comments with new commits on the same branch.',
		`  4. Push: git push`,
		'  5. Post a brief summary comment on the PR: gh pr comment <num> --body',
		'     "Addressed in <short-sha>: <one-line per thread>"',
		'  6. For comments that are questions or discussion (not code-change), reply',
		'     in-thread with gh api repos/.../pulls/.../comments — be concise.',
		'',
		'Output marker — LAST line:',
		'',
		'FIX_PUSHED: <new HEAD sha>',
		...abortClause(),
	];
	return lines.join('\n');
}

// --- Triage prompt ---

/**
 * Triage runs after a human submits an APPROVED review. Classifies each unresolved
 * comment thread into one of four buckets and outputs a structured plan the system
 * executes (file follow-up issues, post replies, etc.).
 *
 * Per design Q14a: triage does NOT second-guess the human's APPROVED verdict. The
 * "must-fix" bucket exists in the schema for completeness but should never be used
 * here — anything resembling must-fix gets bumped to follow-up.
 */
export function buildTriagePrompt(task: Task, worktree: Worktree): string {
	const lines = [
		...header(task, worktree, 'triage'),
		'',
		'A human reviewer APPROVED the PR. Your job is to triage the line comments on',
		'this approved review into actionable buckets so the human only has to click merge.',
		'',
		`PR: ${task.current_pr_url}`,
		'',
		'Workflow:',
		`  1. Fetch the comments on the approving review: gh pr view ${task.current_pr_number} --json reviews,reviewThreads,comments`,
		'  2. Classify each comment thread into one of:',
		'     • follow-up    — a real suggestion worth implementing later. Action: file an issue.',
		'     • dismiss      — nit, "lgtm just fyi", emoji, off-topic. Action: nothing.',
		'     • open-question — reviewer asked you something. Action: reply in-thread.',
		'     • must-fix     — DO NOT use this bucket. The human approved; trust their verdict.',
		'        If a comment looks like must-fix, downgrade it to follow-up.',
		'  3. For each follow-up: gh issue create --title "<summary>" --body "<context + link to PR thread>"',
		'  4. For each open-question: reply via gh api or gh pr comment with a concise answer.',
		'  5. Skip dismiss bucket entirely.',
		'',
		'Be CONSERVATIVE: when uncertain, prefer follow-up over dismiss. Pollution is',
		'fixable; missing a real concern is not.',
		'',
		'Output: a JSON plan as the LAST block of your response, fenced like this:',
		'',
		'TRIAGE_PLAN:',
		'```json',
		'[',
		'  {"thread_id": "...", "bucket": "follow-up", "action": "filed issue #N", "reasoning": "..."},',
		'  {"thread_id": "...", "bucket": "dismiss", "action": null, "reasoning": "..."}',
		']',
		'```',
		'END_TRIAGE_PLAN',
		'',
		'The plan is for audit; you have already taken the actions above. The system',
		'will advance the task to awaiting_merge once it sees END_TRIAGE_PLAN.',
		...abortClause(),
	];
	return lines.join('\n');
}

// --- Marker patterns (consumed by job-poller) ---

export const BRANCH_PUSHED_PATTERN = /BRANCH_PUSHED:\s*(\S+)/;
export const FIX_PUSHED_PATTERN = /FIX_PUSHED:\s*(\S+)/;
export const ABORT_TASK_PATTERN = /ABORT_TASK:\s*(.+)/;
export const TRIAGE_PLAN_PATTERN = /TRIAGE_PLAN:\s*```json\s*([\s\S]*?)\s*```\s*END_TRIAGE_PLAN/;
