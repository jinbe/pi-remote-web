import { onSessionsChanged } from '$lib/server/session-watcher';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const unsubscribe = onSessionsChanged(() => {
				try {
					controller.enqueue(encoder.encode(`data: {"type":"sessions_changed"}\n\n`));
				} catch {
					/* stream closed */
				}
			});

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					/* stream closed */
				}
			}, 30000);

			request.signal.addEventListener('abort', () => {
				unsubscribe();
				clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
