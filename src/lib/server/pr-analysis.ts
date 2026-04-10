/**
 * PR pre-analysis — examines a PR's diff to produce tailored review instructions.
 *
 * Before dispatching a review session, we run a cheap one-shot LLM call
 * (via the active harness CLI) to classify the PR's stack, nature of work,
 * and key areas of concern. The output is injected into the review prompt
 * so the reviewer focuses on what actually matters for that specific PR.
 *
 * Falls back gracefully: if the CLI isn't available or the call fails,
 * analyzePr returns null and the review uses the default generic prompt.
 */
import { execGh, parsePrUrl } from './gh-utils';
import { log } from './logger';
import type { HarnessType } from './rpc-manager';

// --- Types ---

export interface PrAnalysis {
	/** Tailored review instructions produced by the pre-analysis LLM. */
	reviewPrompt: string;
}

// --- Configuration ---

const ANALYSIS_MODEL = process.env.PI_ANALYSIS_MODEL || '';
const ANALYSIS_TIMEOUT_MS = 30_000;

/** Max diff size (in characters) to send to the analysis LLM. */
const MAX_DIFF_LENGTH = 100_000;

const ANALYSIS_SYSTEM_PROMPT = `You are a PR analysis agent. Given a git diff, produce tailored code review instructions.

Analyze the diff and output:

1. A one-line summary of what the PR does.
2. The stack/languages/frameworks involved.
3. The nature of the changes (backend, frontend, UI, infra, database, security, API, tests, docs, etc.).
4. Specific review instructions: what to focus on, what expertise to bring, what pitfalls to watch for.

Be concrete and specific to THIS diff. Do not give generic advice.
Output plain text instructions that a code reviewer will follow. No JSON, no markdown headers.`;

// --- Public API ---

/**
 * Analyze a PR and produce tailored review instructions.
 * Returns null if analysis fails or the harness CLI is unavailable.
 */
export async function analyzePr(prUrl: string, harness: HarnessType = 'pi'): Promise<PrAnalysis | null> {
	try {
		const diff = await fetchPrDiff(prUrl);
		if (!diff) {
			log.warn('pr-analysis', `no diff returned for ${prUrl}`);
			return null;
		}

		const reviewPrompt = await classifyPr(diff, harness);
		if (!reviewPrompt) {
			return null;
		}

		log.info('pr-analysis', `analysis complete for ${prUrl} (${reviewPrompt.length} chars)`);
		return { reviewPrompt };
	} catch (err) {
		log.warn('pr-analysis', `analysis failed for ${prUrl}: ${err}`);
		return null;
	}
}

// --- Internal ---

/**
 * Fetch the full diff for a PR via `gh pr diff`.
 */
async function fetchPrDiff(prUrl: string): Promise<string | null> {
	const parsed = parsePrUrl(prUrl);
	if (!parsed) {
		log.warn('pr-analysis', `cannot parse PR URL: ${prUrl}`);
		return null;
	}

	const diff = await execGh([
		'pr', 'diff', String(parsed.number),
		'--repo', `${parsed.owner}/${parsed.repo}`,
	]);

	return diff || null;
}

/**
 * Run the harness CLI in one-shot mode to classify the PR diff
 * and produce tailored review instructions.
 */
async function classifyPr(diff: string, harness: HarnessType): Promise<string | null> {
	const truncatedDiff = diff.length > MAX_DIFF_LENGTH
		? diff.slice(0, MAX_DIFF_LENGTH) + '\n\n[diff truncated]'
		: diff;

	const { bin, args } = buildAnalysisCommand(harness);

	try {
		const proc = Bun.spawn([bin, ...args], {
			stdin: new Blob([truncatedDiff]),
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const result = await Promise.race([
			(async () => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { stdout, stderr, exitCode };
			})(),
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					proc.kill();
					reject(new Error(`analysis timed out after ${ANALYSIS_TIMEOUT_MS}ms`));
				}, ANALYSIS_TIMEOUT_MS);
			}),
		]);

		if (result.exitCode !== 0) {
			log.warn('pr-analysis', `${bin} exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`);
			return null;
		}

		const output = result.stdout.trim();
		if (!output) {
			log.warn('pr-analysis', `${bin} produced empty output`);
			return null;
		}

		return output;
	} catch (err) {
		log.warn('pr-analysis', `failed to run ${bin}: ${err}`);
		return null;
	}
}

/**
 * Build the harness-specific command for the analysis one-shot.
 */
function buildAnalysisCommand(harness: HarnessType): { bin: string; args: string[] } {
	if (harness === 'claude-code') {
		const bin = process.env.CLAUDE_BIN || 'claude';
		const model = ANALYSIS_MODEL || 'haiku';
		return {
			bin,
			args: [
				'-p',
				'--bare',
				'--model', model,
				'--system-prompt', ANALYSIS_SYSTEM_PROMPT,
			],
		};
	}

	// pi harness
	const bin = process.env.PI_BIN || 'pi';
	const model = ANALYSIS_MODEL || 'gemini-2.0-flash';
	return {
		bin,
		args: [
			'-p',
			'--no-extensions',
			'--no-skills',
			'--no-prompt-templates',
			'--no-themes',
			'--no-tools',
			'--no-session',
			'--model', model,
			'--system-prompt', ANALYSIS_SYSTEM_PROMPT,
		],
	};
}
