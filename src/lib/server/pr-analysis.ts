/**
 * PR pre-analysis — examines a PR's diff to produce tailored review instructions.
 *
 * Before dispatching a review session, we classify the PR's stack, nature of
 * work, risk level, and hosting platform, then generate tailored review
 * instructions guided by the Code Review Principles (SOLID, DRY, naming,
 * error handling, scale, etc.).
 *
 * Two backends are supported:
 *   1. OpenRouter API (preferred) — when OPEN_ROUTER_API_KEY is set, runs a
 *      two-step pipeline: (a) fast structured JSON classification, then
 *      (b) model-generated review instructions informed by the classification,
 *      the diff, and the Code Review Principles. Falls back to rules-based
 *      instruction generation if step (b) fails.
 *   2. Harness CLI fallback — spawns the active harness (claude/pi) in one-shot
 *      mode for a free-text classification.
 *
 * Falls back gracefully: if all backends fail, analyzePr returns null and the
 * review uses the default generic prompt.
 */
import { execGh, parsePrUrl } from './gh-utils';
import { log } from './logger';
import type { HarnessType } from './rpc-manager';

// --- Types ---

export interface PrClassification {
	type: string;
	risk: 'low' | 'medium' | 'high' | 'critical';
	area: string;
	estimated_review_depth: string;
	summary: string;
	languages: string[];
	primary_language: string;
	stack: {
		frontend?: string[];
		backend?: string[];
		database?: string[];
		infra?: string[];
		ci_cd?: string[];
	};
	hosting?: {
		platform: string;
		confidence: string;
		signals: string[];
		gotchas: string[];
	};
}

export interface PrAnalysis {
	/** Tailored review instructions for the review agent. */
	reviewPrompt: string;
	/** Structured classification (available when OpenRouter is used). */
	classification?: PrClassification;
}

// --- Configuration ---

const OPEN_ROUTER_API_KEY = process.env.OPEN_ROUTER_API_KEY || '';
const OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Model overrides — defaults follow the tiered strategy. */
const CLASSIFIER_MODEL = process.env.PI_CLASSIFIER_MODEL || 'mistralai/mistral-small-2603';
const ANALYSIS_MODEL = process.env.PI_ANALYSIS_MODEL || '';

/** Tiered analysis models — selected by PR risk level. */
const ANALYSIS_MODEL_MATRIX: Record<string, string> = {
	low: CLASSIFIER_MODEL,
	medium: 'mistralai/devstral-2512',
	high: 'google/gemini-3-flash-preview',
	critical: 'google/gemini-3.1-pro-preview',
};

const ANALYSIS_TIMEOUT_MS = 30_000;

/** Max diff size (in characters) to send to the analysis LLM. */
const MAX_DIFF_LENGTH = 100_000;

// --- OpenRouter classifier system prompt ---

const CLASSIFIER_SYSTEM_PROMPT = `You are a PR classification agent. Given a git diff, PR title, and branch info, produce a structured JSON classification.

Analyze the diff and output a JSON object with these fields:

{
  "type": "feature | bugfix | refactor | chore | docs | test | hotfix",
  "risk": "low | medium | high | critical",
  "area": "frontend | backend | infra | data | auth | payments | api | ci-cd | mixed",
  "estimated_review_depth": "quick_scan | standard | deep_review",
  "summary": "1-2 sentence description of what this PR does",
  "languages": ["typescript", "python", ...],
  "primary_language": "typescript",
  "stack": {
    "frontend": ["next.js", "react", ...],
    "backend": ["express", "bun", ...],
    "database": ["postgres", "sqlite", ...],
    "infra": ["terraform", "docker", ...],
    "ci_cd": ["github-actions", ...]
  },
  "hosting": {
    "platform": "vercel | cloudflare | aws | azure | gcp | fly | railway | render | self-hosted | unknown",
    "confidence": "high | medium | low",
    "signals": ["vercel.json found", ...],
    "gotchas": ["Vercel: edge functions have 128KB code size limit", ...]
  }
}

Risk assessment guide:
- "low": docs, tests, small config changes, style fixes
- "medium": new features, moderate refactors, dependency updates
- "high": auth/security changes, database migrations, API contract changes, payment logic
- "critical": production hotfixes, security patches, data migration scripts

Hosting detection — look for these signals in file paths and diff content:
- Vercel: vercel.json, next.config.*, .vercel/, NEXT_PUBLIC_VERCEL_* env vars
- Cloudflare: wrangler.toml, wrangler.json, _worker.js, @cloudflare/* packages
- AWS: serverless.yml, template.yaml (SAM), cdk.json, amplify.yml, @aws-sdk/*
- Azure: azure-pipelines.yml, host.json, .azure/, bicep files
- GCP: app.yaml, cloudbuild.yaml, firebase.json, @google-cloud/*
- Fly.io: fly.toml
- Railway: railway.json, railway.toml
- Docker/K8s: Dockerfile, docker-compose.yml, k8s/, helm/, Chart.yaml

Platform-specific gotchas to flag:
- Vercel edge functions: 128KB code limit, no Node.js fs/net/child_process
- Cloudflare Workers: no Node.js built-in APIs by default, D1 has no ALTER TABLE DROP COLUMN
- AWS Lambda: 15min timeout, 250MB deploy package, API Gateway 30s hard timeout
- Azure Functions: consumption plan cold starts (5-10s)

Output ONLY valid JSON. No markdown, no explanation, no code fences.`;

// --- Harness CLI fallback system prompt ---

const CLI_ANALYSIS_SYSTEM_PROMPT = `You are a PR analysis agent. Given a git diff, produce tailored code review instructions.

Analyze the diff and output:

1. A one-line summary of what the PR does.
2. The stack/languages/frameworks involved.
3. The nature of the changes (backend, frontend, UI, infra, database, security, API, tests, docs, etc.).
4. Specific review instructions: what to focus on, what expertise to bring, what pitfalls to watch for.

Be concrete and specific to THIS diff. Do not give generic advice.
Output plain text instructions that a code reviewer will follow. No JSON, no markdown headers.`;

// --- Code Review Principles ---
// Distilled from: https://levelup.gitconnected.com/the-ultimate-guideline-for-a-good-code-review-1588bc2979fc

const CODE_REVIEW_PRINCIPLES = `Code Review Principles:

1. SOLID Principles — Check that classes/modules have clear, single responsibilities. Flag if-else/switch chains that should use polymorphism (Strategy pattern). Verify code is open for extension without requiring modification of existing logic. Check that dependencies point toward abstractions.

2. DRY (Don't Repeat Yourself) — Flag duplicated logic across the diff. Look for copy-pasted code with minor parameter differences that should be unified through shared abstractions, generics, or helper functions.

3. Meaningful Names — Verify that new/changed identifiers faithfully represent domain semantics. A first-time reader should understand what each class, method, and variable represents without guessing.

4. No Magic Numbers — Flag hardcoded literals that lack named constants. Numeric and string values should be extracted into well-named constants that explain their purpose and enable reuse.

5. Specific Error Handling — Check that exceptions/errors are caught specifically, not generically. Empty catch blocks and swallowed errors are unacceptable. Each error type should have appropriate handling.

6. Readability Over Brevity — Less code does not mean better code. Complex one-liners should be broken into named intermediate steps. Code should be easy to debug and modify without breaking adjacent logic.

7. Think at Scale — Consider what happens with large datasets. Check for unbounded queries, missing pagination, eager loading of large collections, and operations that assume small input sizes.

8. Tell Don't Ask — Objects should own their behaviour. If code queries an object's state to decide what to do, that logic likely belongs inside the object itself.

9. YAGNI (You Ain't Gonna Need It) — Flag dead code, unused imports, and over-engineered abstractions built for hypothetical future needs. Remove what is not needed now.

10. Null Safety — Check for defensive programming. Look for unguarded calls on potentially null/undefined values. Verify proper use of Optional, null coalescing, or other null-safety patterns appropriate to the language.`;

// --- OpenRouter review analysis system prompt ---

const REVIEW_ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer producing tailored review instructions for a pull request.

You will receive a structured PR classification and the PR diff. Generate specific, actionable review instructions that another code reviewer will follow when reviewing this PR.

${CODE_REVIEW_PRINCIPLES}

Instructions for generating your output:
- Determine which principles are most relevant to the changes in this PR.
- Generate specific, actionable review instructions — reference files, patterns, or code constructs from the diff.
- Do NOT mechanically list all 10 principles. Focus only on those that clearly apply to the changes.
- Include the PR summary, stack context, risk level, and any platform-specific concerns from the classification.
- Be concrete: "Check null handling in the new fetchUser() return path" is better than "Review null safety."
- Keep instructions concise but thorough.

Output plain text review instructions. No JSON, no markdown formatting.`;

// --- Public API ---

/**
 * Analyze a PR and produce tailored review instructions.
 * Prefers OpenRouter when OPEN_ROUTER_API_KEY is set, falls back to harness CLI.
 * Returns null if all backends fail.
 */
export async function analyzePr(prUrl: string, harness: HarnessType = 'pi'): Promise<PrAnalysis | null> {
	try {
		const diff = await fetchPrDiff(prUrl);
		if (!diff) {
			log.warn('pr-analysis', `no diff returned for ${prUrl}`);
			return null;
		}

		// Prefer OpenRouter when API key is available
		if (OPEN_ROUTER_API_KEY) {
			const result = await classifyWithOpenRouter(diff, prUrl);
			if (result) return result;
			log.warn('pr-analysis', 'OpenRouter classification failed, falling back to harness CLI');
		}

		// Fallback: harness CLI one-shot
		const reviewPrompt = await classifyWithCli(diff, harness);
		if (!reviewPrompt) return null;

		log.info('pr-analysis', `CLI analysis complete for ${prUrl} (${reviewPrompt.length} chars)`);
		return { reviewPrompt };
	} catch (err) {
		log.warn('pr-analysis', `analysis failed for ${prUrl}: ${err}`);
		return null;
	}
}

// --- OpenRouter classification ---

/**
 * Classify a PR via OpenRouter API. Returns structured classification
 * and generated review instructions.
 */
async function classifyWithOpenRouter(diff: string, prUrl: string): Promise<PrAnalysis | null> {
	const truncatedDiff = truncateDiff(diff);

	try {
		const response = await fetch(`${OPEN_ROUTER_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${OPEN_ROUTER_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: CLASSIFIER_MODEL,
				messages: [
					{ role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
					{ role: 'user', content: truncatedDiff },
				],
				temperature: 0.1,
				response_format: { type: 'json_object' },
			}),
			signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			log.warn('pr-analysis', `OpenRouter returned ${response.status}: ${body.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as any;
		const content = data?.choices?.[0]?.message?.content;
		if (!content) {
			log.warn('pr-analysis', 'OpenRouter returned empty content');
			return null;
		}

		const classification = normalizeClassification(JSON.parse(content));

		// Step 2: Generate review instructions guided by code review principles
		const modelInstructions = await generateReviewInstructions(classification, diff);
		const reviewPrompt = modelInstructions || buildReviewInstructions(classification);

		log.info('pr-analysis', `OpenRouter for ${prUrl}: risk=${classification.risk}, area=${classification.area}, type=${classification.type}, instructions=${modelInstructions ? 'model' : 'fallback'}`);

		return { reviewPrompt, classification };
	} catch (err) {
		log.warn('pr-analysis', `OpenRouter call failed: ${err}`);
		return null;
	}
}

// --- OpenRouter review analysis (step 2) ---

/**
 * Generate tailored review instructions via OpenRouter, guided by the
 * Code Review Principles. Uses the classification from step 1 plus the
 * raw diff to produce specific, actionable guidance for the reviewer.
 * Returns null on failure — caller falls back to buildReviewInstructions().
 */
async function generateReviewInstructions(
	classification: PrClassification,
	diff: string,
): Promise<string | null> {
	// PI_ANALYSIS_MODEL overrides the matrix; otherwise select by risk level
	const analysisModel = ANALYSIS_MODEL
		|| ANALYSIS_MODEL_MATRIX[classification.risk]
		|| CLASSIFIER_MODEL;
	const truncatedDiff = truncateDiff(diff);
	log.info('pr-analysis', `analysis model: ${analysisModel} (risk=${classification.risk})`);

	try {
		const response = await fetch(`${OPEN_ROUTER_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${OPEN_ROUTER_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: analysisModel,
				messages: [
					{ role: 'system', content: REVIEW_ANALYSIS_SYSTEM_PROMPT },
					{
						role: 'user',
						content: `Classification:\n${JSON.stringify(classification, null, 2)}\n\n---\n\nDiff:\n${truncatedDiff}`,
					},
				],
				temperature: 0.3,
			}),
			signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			log.warn('pr-analysis', `OpenRouter analysis returned ${response.status}: ${body.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as any;
		const content = data?.choices?.[0]?.message?.content;
		if (!content?.trim()) {
			log.warn('pr-analysis', 'OpenRouter analysis returned empty content');
			return null;
		}

		log.info('pr-analysis', `review instructions generated (${content.trim().length} chars)`);
		return content.trim();
	} catch (err) {
		log.warn('pr-analysis', `OpenRouter analysis failed: ${err}`);
		return null;
	}
}

// --- Classification normalization ---

/** Ensure all required fields exist so buildReviewInstructions won't throw. */
function normalizeClassification(raw: any): PrClassification {
	return {
		type: raw.type || 'unknown',
		risk: ['low', 'medium', 'high', 'critical'].includes(raw.risk) ? raw.risk : 'medium',
		area: raw.area || 'mixed',
		estimated_review_depth: raw.estimated_review_depth || 'standard',
		summary: raw.summary || '',
		languages: Array.isArray(raw.languages) ? raw.languages : [],
		primary_language: raw.primary_language || '',
		stack: {
			frontend: Array.isArray(raw.stack?.frontend) ? raw.stack.frontend : undefined,
			backend: Array.isArray(raw.stack?.backend) ? raw.stack.backend : undefined,
			database: Array.isArray(raw.stack?.database) ? raw.stack.database : undefined,
			infra: Array.isArray(raw.stack?.infra) ? raw.stack.infra : undefined,
			ci_cd: Array.isArray(raw.stack?.ci_cd) ? raw.stack.ci_cd : undefined,
		},
		hosting: raw.hosting ? {
			platform: raw.hosting.platform || 'unknown',
			confidence: raw.hosting.confidence || 'low',
			signals: Array.isArray(raw.hosting.signals) ? raw.hosting.signals : [],
			gotchas: Array.isArray(raw.hosting.gotchas) ? raw.hosting.gotchas : [],
		} : undefined,
	};
}

// --- Build review instructions from classification (fallback) ---

/**
 * Convert a structured PrClassification into tailored review instructions
 * that get prepended to the review prompt.
 */
function buildReviewInstructions(c: PrClassification): string {
	const lines: string[] = [];

	// Summary and classification
	lines.push(`PR Summary: ${c.summary}`);
	lines.push(`Classification: ${c.type} | Risk: ${c.risk} | Area: ${c.area} | Depth: ${c.estimated_review_depth}`);
	lines.push('');

	// Stack context
	lines.push(`Primary language: ${c.primary_language}`);
	if (c.languages.length > 1) {
		lines.push(`Languages: ${c.languages.join(', ')}`);
	}

	const stackParts: string[] = [];
	if (c.stack.frontend?.length) stackParts.push(`Frontend: ${c.stack.frontend.join(', ')}`);
	if (c.stack.backend?.length) stackParts.push(`Backend: ${c.stack.backend.join(', ')}`);
	if (c.stack.database?.length) stackParts.push(`Database: ${c.stack.database.join(', ')}`);
	if (c.stack.infra?.length) stackParts.push(`Infra: ${c.stack.infra.join(', ')}`);
	if (c.stack.ci_cd?.length) stackParts.push(`CI/CD: ${c.stack.ci_cd.join(', ')}`);
	if (stackParts.length) {
		lines.push(`Stack: ${stackParts.join(' | ')}`);
	}
	lines.push('');

	// Hosting context and gotchas
	if (c.hosting && c.hosting.platform !== 'unknown') {
		lines.push(`Hosting: ${c.hosting.platform} (confidence: ${c.hosting.confidence})`);
		if (c.hosting.signals.length) {
			lines.push(`Signals: ${c.hosting.signals.join(', ')}`);
		}
		if (c.hosting.gotchas.length) {
			lines.push('');
			lines.push('PLATFORM-SPECIFIC GOTCHAS — check for these:');
			for (const gotcha of c.hosting.gotchas) {
				lines.push(`  - ${gotcha}`);
			}
		}
		lines.push('');
	}

	// Risk-based review focus
	lines.push('Review focus:');
	switch (c.risk) {
		case 'critical':
			lines.push('  - CRITICAL RISK: This PR requires thorough security and correctness review.');
			lines.push('  - Verify no regressions in production-critical paths.');
			lines.push('  - Check for data integrity, auth bypass, and injection vulnerabilities.');
			lines.push('  - Validate rollback strategy exists.');
			break;
		case 'high':
			lines.push('  - HIGH RISK: Pay close attention to security, data integrity, and API contracts.');
			lines.push('  - Check for breaking changes, missing migrations, and edge cases.');
			lines.push('  - Verify test coverage for critical paths.');
			break;
		case 'medium':
			lines.push('  - MEDIUM RISK: Standard review depth.');
			lines.push('  - Check logic correctness, error handling, and test coverage.');
			lines.push('  - Look for performance implications and maintainability.');
			break;
		case 'low':
			lines.push('  - LOW RISK: Quick scan for obvious issues.');
			lines.push('  - Verify changes match the stated intent.');
			lines.push('  - Check for typos, style consistency, and documentation accuracy.');
			break;
	}

	// Area-specific guidance
	const areaGuidance = getAreaGuidance(c.area);
	if (areaGuidance.length) {
		lines.push('');
		lines.push('Area-specific checks:');
		for (const item of areaGuidance) {
			lines.push(`  - ${item}`);
		}
	}

	return lines.join('\n');
}

function getAreaGuidance(area: string): string[] {
	switch (area) {
		case 'auth':
			return [
				'Verify no credentials or tokens are hardcoded or logged.',
				'Check session handling, token expiry, and privilege escalation.',
				'Ensure auth checks cannot be bypassed.',
			];
		case 'payments':
			return [
				'Verify idempotency of payment operations.',
				'Check for race conditions in balance/charge logic.',
				'Ensure proper error handling for payment provider failures.',
			];
		case 'api':
			return [
				'Check for breaking changes to request/response contracts.',
				'Verify input validation and error response formats.',
				'Look for missing rate limiting or auth middleware.',
			];
		case 'infra':
			return [
				'Verify no secrets or credentials in config files.',
				'Check for destructive operations (resource deletion, data loss).',
				'Validate IAM/permission changes are least-privilege.',
			];
		case 'data':
			return [
				'Check migration safety (reversibility, data preservation).',
				'Verify query performance (indexes, N+1 queries).',
				'Look for SQL injection or unsafe query construction.',
			];
		case 'frontend':
			return [
				'Check for XSS vulnerabilities in user-rendered content.',
				'Verify accessibility (ARIA, keyboard navigation, contrast).',
				'Look for performance issues (large bundles, unnecessary re-renders).',
			];
		case 'backend':
			return [
				'Check error handling and logging.',
				'Verify concurrent access safety (race conditions, deadlocks).',
				'Look for resource leaks (unclosed connections, file handles).',
			];
		default:
			return [];
	}
}

// --- Harness CLI fallback ---

/**
 * Run the harness CLI in one-shot mode to produce free-text review instructions.
 */
async function classifyWithCli(diff: string, harness: HarnessType): Promise<string | null> {
	const truncatedDiff = truncateDiff(diff);
	const { bin, args } = buildCliCommand(harness);

	try {
		const proc = Bun.spawn([bin, ...args], {
			stdin: new Blob([truncatedDiff]),
			stdout: 'pipe',
			stderr: 'pipe',
		});

		let timeoutId: number | undefined;
		const result = await Promise.race([
			(async () => {
				try {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
						proc.exited,
					]);
					return { stdout, stderr, exitCode };
				} finally {
					if (timeoutId !== undefined) {
						clearTimeout(timeoutId);
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					try { proc.kill(); } catch {}
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

function buildCliCommand(harness: HarnessType): { bin: string; args: string[] } {
	if (harness === 'claude-code') {
		const bin = process.env.CLAUDE_BIN || 'claude';
		const model = ANALYSIS_MODEL || 'haiku';
		return {
			bin,
			args: [
				'-p',
				'--model', model,
				'--system-prompt', CLI_ANALYSIS_SYSTEM_PROMPT,
			],
		};
	}

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
			'--system-prompt', CLI_ANALYSIS_SYSTEM_PROMPT,
		],
	};
}

// --- Shared helpers ---

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

function truncateDiff(diff: string): string {
	return diff.length > MAX_DIFF_LENGTH
		? diff.slice(0, MAX_DIFF_LENGTH) + '\n\n[diff truncated]'
		: diff;
}
