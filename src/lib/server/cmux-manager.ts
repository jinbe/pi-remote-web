/**
 * cmux-manager: implements cmux-compatible operations on top of pi-remote-web's
 * session management infrastructure.
 *
 * Maps cmux concepts to pi-remote-web concepts:
 *   - surface  → session ID (base64url-encoded session file path)
 *   - split    → create a new pi session
 *   - send     → prompt/steer/follow_up a session
 *   - read     → get tail messages + streaming text
 *   - close    → stop a session
 *   - list     → list active sessions
 *   - notify   → log a notification event
 *
 * Limitations:
 *   - All agents are pi (no claude code support)
 *   - No browser QA surface support
 *   - Key sends are limited to "enter" (triggers message submission)
 */
import {
	createSession,
	sendMessage,
	stopSession,
	getActiveSessionIds,
	getActiveSession,
	getStreamingState,
	subscribe,
	isActive,
	getState,
} from './rpc-manager';
import {
	decodeSessionId,
	parseSessionMetadata,
	getTailMessages,
} from './session-scanner';
import { log } from './logger';

// --- Types ---

interface SplitParams {
	action: 'split';
	cwd: string;
	model?: string;
	direction?: string; // ignored — no spatial layout, but accepted for compat
}

interface SendParams {
	action: 'send';
	surface: string;
	text?: string;
	key?: string;
	behavior?: 'steer' | 'followUp';
}

interface ReadParams {
	action: 'read';
	surface: string;
	lines?: number;
}

interface CloseParams {
	action: 'close';
	surface: string;
}

interface NotifyParams {
	action: 'notify';
	title: string;
	body?: string;
}

// --- Pending text buffer ---
// cmux_send works in two steps: first send text, then send key="enter".
// We buffer the text until "enter" is received, then dispatch as a prompt.
const pendingText = new Map<string, string>();

/** Reset internal state — used by tests only. */
export function _resetForTests(): void {
	pendingText.clear();
	outputBuffers.clear();
}

// --- Output buffer ---
// Captures streaming events for cmux_read. Each session gets a rolling buffer
// of rendered text output so agents can poll for recent content.
const OUTPUT_BUFFER_MAX = 100 * 1024; // 100KB per session

interface OutputBuffer {
	text: string;
	subscribed: boolean;
}

const outputBuffers = new Map<string, OutputBuffer>();

function ensureOutputBuffer(sessionId: string): OutputBuffer {
	let buf = outputBuffers.get(sessionId);
	if (buf) return buf;

	buf = { text: '', subscribed: false };
	outputBuffers.set(sessionId, buf);

	// Subscribe to session events to capture output
	if (isActive(sessionId) && !buf.subscribed) {
		buf.subscribed = true;
		subscribe(sessionId, (event) => {
			const buffer = outputBuffers.get(sessionId);
			if (!buffer) return;

			let chunk = '';

			if (event.type === 'message_update') {
				const ame = event.assistantMessageEvent;
				if (ame?.type === 'text_delta') {
					chunk = ame.delta;
				} else if (ame?.type === 'thinking_delta') {
					// Include thinking in output for orchestrator visibility
					chunk = ame.delta;
				}
			} else if (event.type === 'message_start' && event.message?.role === 'assistant') {
				chunk = '\n--- assistant ---\n';
			} else if (event.type === 'agent_end') {
				chunk = '\n--- agent done ---\n';
			} else if (event.type === 'session_ended') {
				chunk = '\n--- session ended ---\n';
				// Clean up pending text on session end
				pendingText.delete(sessionId);
			} else if (event.type === 'message_start' && event.message?.role === 'tool') {
				// Render tool usage summary
				const tool = event.message;
				if (tool?.content) {
					for (const block of tool.content) {
						if (block.type === 'tool_result') {
							const name = block.tool_name || 'tool';
							chunk += `\n[${name}] `;
							if (block.text) chunk += block.text.slice(0, 500);
							chunk += '\n';
						}
					}
				}
			}

			if (chunk) {
				buffer.text += chunk;
				if (buffer.text.length > OUTPUT_BUFFER_MAX) {
					buffer.text = buffer.text.slice(-OUTPUT_BUFFER_MAX);
				}
			}
		});
	}

	return buf;
}

// --- Handlers ---

export async function handleSplit(params: SplitParams): Promise<{
	ok: boolean;
	surface: string;
	sessionId: string;
}> {
	const { cwd, model } = params;

	if (!cwd) {
		throw new Error('Missing "cwd" — working directory is required for split');
	}

	log.info('cmux', `split: cwd=${cwd} model=${model || 'default'}`);

	const sessionId = await createSession(cwd, model);

	// Initialise the output buffer for this new session
	ensureOutputBuffer(sessionId);

	return {
		ok: true,
		surface: sessionId,
		sessionId,
	};
}

export async function handleSend(params: SendParams): Promise<{
	ok: boolean;
	queued?: boolean;
	sent?: boolean;
}> {
	const { surface, text, key, behavior } = params;

	if (!surface) throw new Error('Missing "surface"');
	if (!isActive(surface)) throw new Error(`Session not active: ${surface}`);

	// Ensure we're capturing output for this session
	ensureOutputBuffer(surface);

	// Handle the two-step cmux_send pattern:
	// Step 1: cmux_send surface=X text="..." → buffer the text
	// Step 2: cmux_send surface=X key="enter" → dispatch as prompt

	if (text && !key) {
		// Buffer text — waiting for "enter" key
		const existing = pendingText.get(surface) || '';
		pendingText.set(surface, existing + text);
		log.info('cmux', `send: buffered text for ${surface} (${text.length} chars)`);
		return { ok: true, queued: true };
	}

	if (key === 'enter') {
		const buffered = pendingText.get(surface) || '';
		pendingText.delete(surface);

		if (!buffered) {
			log.warn('cmux', `send: enter with no buffered text for ${surface}`);
			return { ok: true, sent: false };
		}

		// Clean up the text — remove trailing newlines that cmux patterns often include
		const message = buffered.replace(/\n+$/, '');

		log.info('cmux', `send: dispatching prompt to ${surface} (${message.length} chars)`);

		// Determine the send behaviour
		const sendBehavior = behavior || undefined;
		await sendMessage(surface, message, sendBehavior);

		return { ok: true, sent: true };
	}

	// If both text and key are provided together, send directly
	if (text && key === 'enter') {
		const message = text.replace(/\n+$/, '');
		const sendBehavior = behavior || undefined;
		await sendMessage(surface, message, sendBehavior);
		return { ok: true, sent: true };
	}

	// Other keys — not supported in this implementation
	if (key && key !== 'enter') {
		log.warn('cmux', `send: unsupported key "${key}" for ${surface}`);
		return { ok: true, sent: false };
	}

	throw new Error('Must provide "text" and/or "key"');
}

export async function handleRead(params: ReadParams): Promise<{
	ok: boolean;
	surface: string;
	output: string;
	isStreaming: boolean;
	lines: string[];
}> {
	const { surface, lines: lineCount = 150 } = params;

	if (!surface) throw new Error('Missing "surface"');

	// Ensure output buffer exists
	const buf = ensureOutputBuffer(surface);

	// Get streaming state
	const streaming = getStreamingState(surface);

	// Combine output buffer with tail messages for a comprehensive view
	let output = '';

	// Try to get recent messages from session file for historical context
	try {
		const filePath = decodeSessionId(surface);
		const tail = await getTailMessages(filePath, Math.min(lineCount, 50));
		if (tail.messages.length > 0) {
			const rendered = renderMessagesAsText(tail.messages);
			output += rendered;
		}
	} catch {
		// Session file may not be readable yet
	}

	// Append streaming buffer (more recent real-time content)
	if (buf.text) {
		output += buf.text;
	}

	// Split into lines and return the last N
	const allLines = output.split('\n');
	const trimmedLines = allLines.slice(-lineCount);

	return {
		ok: true,
		surface,
		output: trimmedLines.join('\n'),
		isStreaming: streaming.isStreaming,
		lines: trimmedLines,
	};
}

export async function handleClose(params: CloseParams): Promise<{
	ok: boolean;
	surface: string;
}> {
	const { surface } = params;

	if (!surface) throw new Error('Missing "surface"');

	log.info('cmux', `close: ${surface}`);

	await stopSession(surface);

	// Clean up buffers
	pendingText.delete(surface);
	outputBuffers.delete(surface);

	return { ok: true, surface };
}

export async function handleList(): Promise<{
	ok: boolean;
	sessions: Array<{
		surface: string;
		cwd: string;
		model: string | null;
		isStreaming: boolean;
		name: string | null;
		firstMessage: string | null;
	}>;
}> {
	const activeIds = [...getActiveSessionIds()];

	const sessions = await Promise.all(
		activeIds.map(async (id) => {
			const info = getActiveSession(id);
			const streaming = getStreamingState(id);
			let name: string | null = null;
			let firstMessage: string | null = null;

			try {
				const filePath = decodeSessionId(id);
				const meta = await parseSessionMetadata(filePath);
				name = meta.name;
				firstMessage = meta.firstMessage;
			} catch {
				// New session may not have metadata yet
			}

			return {
				surface: id,
				cwd: info?.cwd ?? '',
				model: info?.model ?? null,
				isStreaming: streaming.isStreaming,
				name,
				firstMessage,
			};
		})
	);

	return { ok: true, sessions };
}

export async function handleNotify(params: NotifyParams): Promise<{
	ok: boolean;
}> {
	const { title, body } = params;

	if (!title) throw new Error('Missing "title"');

	log.info('cmux', `notify: ${title}${body ? ' — ' + body : ''}`);

	// In future this could push to connected web clients via SSE
	// For now, just log it
	return { ok: true };
}

// --- Helpers ---

/**
 * Render session messages as plain text for cmux_read output.
 * This mimics what a terminal would show — assistant text, tool calls, etc.
 */
function renderMessagesAsText(messages: any[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.type === 'compaction') {
			parts.push('[compacted]\n');
			continue;
		}

		if (msg.type !== 'message') continue;

		const role = msg.message?.role;
		const content = msg.message?.content;

		if (!content) continue;

		if (role === 'user') {
			// Show user messages briefly
			const text = typeof content === 'string'
				? content
				: content
					.filter((b: any) => b.type === 'text')
					.map((b: any) => b.text)
					.join('');
			if (text) {
				parts.push(`> ${text.slice(0, 500)}\n`);
			}
		} else if (role === 'assistant') {
			if (typeof content === 'string') {
				parts.push(content + '\n');
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'text') {
						parts.push(block.text + '\n');
					} else if (block.type === 'tool_use') {
						parts.push(`[tool: ${block.name}]\n`);
					}
				}
			}
		} else if (role === 'tool') {
			// Summarise tool results
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'tool_result' && block.content) {
						const text = typeof block.content === 'string'
							? block.content
							: Array.isArray(block.content)
								? block.content
									.filter((b: any) => b.type === 'text')
									.map((b: any) => b.text)
									.join('')
								: '';
						if (text) {
							parts.push(`[result] ${text.slice(0, 500)}\n`);
						}
					}
				}
			}
		}
	}

	return parts.join('');
}
