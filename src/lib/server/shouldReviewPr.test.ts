import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock Bun.spawn to intercept execGh calls ---

let apiResponses: Map<string, string> = new Map();

/**
 * Track spawn calls for assertion. Each entry records the full args array
 * passed to `gh`.
 */
let spawnCalls: string[][] = [];

// Patch Bun.spawn globally — execGh calls Bun.spawn(['gh', ...args], ...)
const originalSpawn = Bun.spawn;

function mockSpawn(cmd: string | string[], opts?: any): any {
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

// --- Helpers ---

const OWNER = 'acme';
const REPO = 'widget';
const PR_NUM = 42;
const PR_AUTHOR = 'alice';
const GH_USER = 'bob';

function reviewsEndpoint() {
	return `repos/${OWNER}/${REPO}/pulls/${PR_NUM}/reviews`;
}

function commentsEndpoint() {
	return `repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`;
}

function setReviews(reviews: Array<{ user: string; state: string; submitted_at: string }>) {
	apiResponses.set(reviewsEndpoint(), JSON.stringify(reviews));
}

function setComments(comments: Array<{ user: string; body: string; created_at: string }>) {
	apiResponses.set(commentsEndpoint(), JSON.stringify(comments));
}

describe('shouldReviewPr', () => {
	beforeEach(() => {
		apiResponses = new Map();
		spawnCalls = [];
	});

	it('skips self-authored PRs', async () => {
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, GH_USER, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('self-authored');
	});

	it('returns needs review for new PR with no activity', async () => {
		setReviews([]);
		setComments([]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('new PR');
	});

	it('skips when latest activity is an approval', async () => {
		setReviews([
			{ user: 'carol', state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T10:00:00Z' },
			{ user: 'carol', state: 'APPROVED', submitted_at: '2025-01-01T12:00:00Z' },
		]);
		setComments([]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('approved');
		expect(result.reason).toContain('carol');
	});

	it('skips when my review is the latest activity', async () => {
		setReviews([
			{ user: GH_USER, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T12:00:00Z' },
		]);
		setComments([]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('last review is mine');
		expect(result.reason).toContain('waiting on author');
	});

	it('triggers re-review when author comments after my review', async () => {
		setReviews([
			{ user: GH_USER, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T10:00:00Z' },
		]);
		setComments([
			{ user: PR_AUTHOR, body: 'Fixed the issues', created_at: '2025-01-01T12:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('skips when non-author comment contains dismiss keyword', async () => {
		setReviews([]);
		setComments([
			{ user: 'carol', body: 'LGTM, ship it!', created_at: '2025-01-01T12:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('lgtm');
	});

	it('skips when non-author comments without dismiss keyword', async () => {
		setReviews([]);
		setComments([
			{ user: 'carol', body: "I'll handle this review", created_at: '2025-01-01T12:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('not PR author');
	});

	it('uses chronological ordering: author comment after approval triggers re-review', async () => {
		setReviews([
			{ user: 'carol', state: 'APPROVED', submitted_at: '2025-01-01T10:00:00Z' },
		]);
		setComments([
			{ user: PR_AUTHOR, body: 'Wait, I pushed more changes', created_at: '2025-01-01T14:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('uses chronological ordering: approval after author comment skips', async () => {
		setComments([
			{ user: PR_AUTHOR, body: 'Fixed the issues', created_at: '2025-01-01T10:00:00Z' },
		]);
		setReviews([
			{ user: 'carol', state: 'APPROVED', submitted_at: '2025-01-01T14:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('approved');
	});

	it('handles many events and picks the most recent one', async () => {
		setReviews([
			{ user: GH_USER, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T08:00:00Z' },
			{ user: 'carol', state: 'COMMENTED', submitted_at: '2025-01-01T09:00:00Z' },
		]);
		setComments([
			{ user: PR_AUTHOR, body: 'Addressed feedback', created_at: '2025-01-01T10:00:00Z' },
			{ user: 'dave', body: 'Looks good to me, lgtm', created_at: '2025-01-01T11:00:00Z' },
			{ user: PR_AUTHOR, body: 'One more fix pushed', created_at: '2025-01-01T15:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		// Most recent is author's comment at 15:00
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('author commented');
	});

	it('treats someone else\'s non-approval review as needing attention', async () => {
		setReviews([
			{ user: 'carol', state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T12:00:00Z' },
		]);
		setComments([]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(true);
		expect(result.reason).toContain('carol');
		expect(result.reason).toContain('CHANGES_REQUESTED');
	});

	it('is case-insensitive for user comparison', async () => {
		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, 'Bob', 'bob');
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('self-authored');
	});

	it('uses --paginate flag in API calls', async () => {
		setReviews([]);
		setComments([]);

		await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);

		// Both gh calls should include --paginate
		expect(spawnCalls.length).toBe(2);
		for (const args of spawnCalls) {
			expect(args).toContain('--paginate');
		}
	});

	it('dismiss keyword match is case-insensitive', async () => {
		setReviews([]);
		setComments([
			{ user: 'carol', body: 'APPROVED, Looks Good To Me', created_at: '2025-01-01T12:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('approve');
	});

	it('my review followed by dismiss-keyword comment from another user skips', async () => {
		setReviews([
			{ user: GH_USER, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T10:00:00Z' },
		]);
		setComments([
			{ user: 'carol', body: "Don't merge this yet, wip", created_at: '2025-01-01T12:00:00Z' },
		]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('wip');
	});

	it('parses NDJSON multi-page responses from --paginate', async () => {
		// Simulate gh api --paginate output: each page emits a separate JSON array
		const page1 = JSON.stringify([
			{ user: 'carol', state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T08:00:00Z' },
		]);
		const page2 = JSON.stringify([
			{ user: 'dave', state: 'APPROVED', submitted_at: '2025-01-01T14:00:00Z' },
		]);
		apiResponses.set(reviewsEndpoint(), `${page1}\n${page2}`);
		setComments([]);

		const result = await shouldReviewPr(OWNER, REPO, PR_NUM, PR_AUTHOR, GH_USER);
		// Most recent review (page 2) is an approval by dave
		expect(result.shouldReview).toBe(false);
		expect(result.reason).toContain('approved');
		expect(result.reason).toContain('dave');
	});
});
