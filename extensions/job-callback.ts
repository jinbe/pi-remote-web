import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const JOB_ID_PATTERN = /JOB_ID:\s*(\S+)/;
const CALLBACK_PATTERN = /CALLBACK_URL:\s*(\S+)/;
const CALLBACK_TOKEN_PATTERN = /CALLBACK_TOKEN:\s*(\S+)/;
const PR_URL_PATTERN = /PR_URL:\s*(\S+)/;
const VERDICT_PATTERN = /VERDICT:\s*(approved|changes_requested)/;

const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

/**
 * Pi extension that fires on agent_end, extracts job metadata and results
 * from the conversation, and POSTs results back to pi-remote-web.
 */
export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		try {
			const messages = ctx.messages ?? [];
			if (messages.length === 0) return;

			// Extract job metadata from all messages (could be in system or user messages)
			const allText = messages.map((m: any) => extractText(m)).join("\n");
			const jobIdMatch = allText.match(JOB_ID_PATTERN);
			const callbackMatch = allText.match(CALLBACK_PATTERN);
			const tokenMatch = allText.match(CALLBACK_TOKEN_PATTERN);

			if (!jobIdMatch || !callbackMatch) return;

			const jobId = jobIdMatch[1];
			const callbackUrl = callbackMatch[1];
			const callbackToken = tokenMatch?.[1];

			// Extract results from assistant messages only
			const assistantText = messages
				.filter((m: any) => m.role === "assistant")
				.map((m: any) => extractText(m))
				.join("\n");

			const prUrlMatch = assistantText.match(PR_URL_PATTERN);
			const verdictMatch = assistantText.match(VERDICT_PATTERN);

			// If there's a verdict, the agent was reviewing → report as done.
			// Otherwise it was a task phase → report as reviewing so the server
			// doesn't race past reviewing into done for fire-and-forget jobs.
			const payload: Record<string, string | undefined> = {
				jobId,
				status: verdictMatch ? "done" : "reviewing",
				token: callbackToken,
			};

			if (prUrlMatch) payload.prUrl = prUrlMatch[1];
			if (verdictMatch) payload.verdict = verdictMatch[1];

			await postWithRetry(callbackUrl, payload);
		} catch (err) {
			// Silently fail — we don't want extension errors to disrupt the agent
			console.error("[job-callback] Error processing agent_end:", err);
		}
	});
}

/**
 * Extract plain text content from a message object.
 */
function extractText(message: any): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text ?? "")
			.join("\n");
	}
	return "";
}

/**
 * POST results to callback URL with retry logic.
 */
async function postWithRetry(
	url: string,
	payload: Record<string, string | undefined>,
): Promise<void> {
	for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (response.ok) return;

			console.error(
				`[job-callback] POST attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed: ${response.status} ${response.statusText}`,
			);
		} catch (err) {
			console.error(
				`[job-callback] POST attempt ${attempt}/${MAX_RETRY_ATTEMPTS} error:`,
				err,
			);
		}

		if (attempt < MAX_RETRY_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}

	console.error(
		`[job-callback] All ${MAX_RETRY_ATTEMPTS} attempts to POST to ${url} failed`,
	);
}
