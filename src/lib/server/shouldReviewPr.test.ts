import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock Bun.spawn to intercept execGh calls ---

let apiResponses: Map<string, string> = new Map();

/**
 * Track spawn calls for assertion. Each entry records the full args array
 * passed to `gh`.
 */
let spawnCalls: string[][] = [];

// Patch Bun.spawn globally — execGh calls Bun.spawn(['gh', ...args], ...)
function mockSpawn(cmd: string | string[], _opts?: any): any {
	const args = Array.isArray(cmd) ? cmd : [cmd];
	// Record the gh args (skip the 'gh' binary itself)
	if (args[0] === 'gh') {
		spawnCalls.push(args.slice(1));
	}

	// Find the API endpoint in the args to determine the response
	const apiEndpoint = args.find(a => typeof a === 'string' && a.startsWith('repos/'));
	const response = apiEndpoint ? (apiResponses.get(apiEndpoint) ?? '[]') : '[]';

	// Return a mock process object that execGh expects
	return {
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(response));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(0),
		kill: () => {},
	};
}

// Apply the mock
(Bun as any).spawn = mockSpawn;

// --- Mock logger to suppress output ---
mock.module('./logger', () => ({
	log: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	},
}));

// Import after mocking
const { shouldReviewPr } = await import('./github-pr-poller');
type PrReviewState = import('./github-pr-poller').PrReviewState;

// --- Helpers ---

const OWNER = 'acme';
const REPO = 'widget';
const PR_NUM = 42;
const PR_AUTHOR = 'alice';
const GH_USER = 'bob';
const SHA_A = 'aaaaaaa1111111111111111111111111111aaaaa';
const SHA_B = 'bbbbbbb2222222222222222222222222222bbbbb';

function commentsEndpoint() {
	return `repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`;
}

function setComments(comments: Array<{ user: string; created_at: string }>) {
	apiResponses.set(commentsEndpoint(), JSON.stringify(comments));
}

function state(sha: string, reviewedAt: string): PrReviewState {
	return { last_reviewed_head_sha: sha, last_reviewed_at: reviewedAt };
}

describe('shouldReviewPr', () => {
	beforeEach(() => {
		apiResponses = new Map();
		spawnCalls = [];
	});

	it('skips self-authored PRs', async () => {
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, GH_USER, GH_USER, SHA_A, null);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('self-authored');
	});

	it('is case-insensitive for self-authored check', async () => {
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, 'Bob', 'bob', SHA_A, null);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('self-authored');
	});

	it('triggers review when there is no prior state (new PR)', async () => {
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, null);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('new PR');
	});

	it('does not fetch comments when there is no prior state', async () => {
		await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, null);
		// No gh calls should have been made — brand-new PR short-circuits
		expect(spawnCalls.length).toBe(0);
	});

	it('triggers review when head SHA has changed (new commits)', async () => {
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_B, prior);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('new commits');
	});

	it('does not fetch comments when head SHA has changed', async () => {
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_B, prior);
		// SHA change short-circuits — no need to check comments
		expect(spawnCalls.length).toBe(0);
	});

	it('triggers review when author has commented since last review', async () => {
		setComments([
			{ user: PR_AUTHOR, created_at: '2025-01-01T12:00:00Z' },
		]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('skips when author comment is older than last review', async () => {
		setComments([
			{ user: PR_AUTHOR, created_at: '2025-01-01T08:00:00Z' },
		]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('no new commits or author comments');
	});

	it('skips when only non-author has commented since last review', async () => {
		setComments([
			{ user: 'carol', created_at: '2025-01-01T12:00:00Z' },
			{ user: GH_USER, created_at: '2025-01-01T13:00:00Z' },
		]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('no new commits or author comments');
	});

	it('skips when no comments exist and head SHA is unchanged', async () => {
		setComments([]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('no new commits or author comments');
	});

	it('author comparison is case-insensitive', async () => {
		setComments([
			{ user: 'Alice', created_at: '2025-01-01T12:00:00Z' },
		]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('uses --paginate flag when fetching comments', async () => {
		setComments([]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);

		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0]).toContain('--paginate');
	});

	it('parses NDJSON multi-page responses from --paginate', async () => {
		const page1 = JSON.stringify([
			{ user: 'carol', created_at: '2025-01-01T08:00:00Z' },
		]);
		const page2 = JSON.stringify([
			{ user: PR_AUTHOR, created_at: '2025-01-01T14:00:00Z' },
		]);
		apiResponses.set(commentsEndpoint(), `${page1}\n${page2}`);

		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('picks a new author comment even when older non-author comments exist', async () => {
		setComments([
			{ user: 'carol', created_at: '2025-01-01T11:00:00Z' },
			{ user: 'dave', created_at: '2025-01-01T11:30:00Z' },
			{ user: PR_AUTHOR, created_at: '2025-01-01T15:00:00Z' },
		]);
		const prior = state(SHA_A, '2025-01-01T10:00:00Z');
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER, SHA_A, prior);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});
});
