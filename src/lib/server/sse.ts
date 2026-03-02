import { subscribe } from './rpc-manager';

export function createSSEStream(sessionId: string, request: Request): Response {
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let cleaned = false;

			function cleanup() {
				if (cleaned) return;
				cleaned = true;
				unsubscribe();
				clearInterval(heartbeat);
				try { controller.close(); } catch { /* already closed */ }
			}

			const unsubscribe = subscribe(sessionId, (event) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					cleanup();
				}
			});

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					cleanup();
				}
			}, 15000);

			request.signal.addEventListener('abort', cleanup);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}
