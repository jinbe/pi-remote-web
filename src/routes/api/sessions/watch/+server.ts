import { onSessionsChanged } from '$lib/server/session-watcher';
import { onJobEvent } from '$lib/server/job-events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const unsubscribeSessions = onSessionsChanged(() => {
				try {
					controller.enqueue(encoder.encode(`data: {"type":"sessions_changed"}\n\n`));
				} catch {
					/* stream closed */
				}
			});

			const unsubscribeJobs = onJobEvent((event) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
				unsubscribeSessions();
				unsubscribeJobs();
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
