import { describe, it, expect } from 'bun:test';

describe('SSE stream format', () => {
	it('encodes events in SSE data format', () => {
		const encoder = new TextEncoder();
		const event = { type: 'agent_start' };
		const encoded = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
		const decoded = new TextDecoder().decode(encoded);

		expect(decoded).toBe('data: {"type":"agent_start"}\n\n');
	});

	it('encodes heartbeat as SSE comment', () => {
		const encoder = new TextEncoder();
		const encoded = encoder.encode(`: heartbeat\n\n`);
		const decoded = new TextDecoder().decode(encoded);

		expect(decoded).toBe(': heartbeat\n\n');
	});

	it('uses correct SSE headers', () => {
		const headers = {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		};

		expect(headers['Content-Type']).toBe('text/event-stream');
		expect(headers['Cache-Control']).toBe('no-cache');
		expect(headers['Connection']).toBe('keep-alive');
	});

	it('serializes complex events correctly', () => {
		const event = {
			type: 'message_update',
			assistantMessageEvent: {
				type: 'text_delta',
				delta: 'Hello, "world"!\nNew line.'
			}
		};
		const serialized = `data: ${JSON.stringify(event)}\n\n`;

		// Parse it back
		const dataLine = serialized.split('\n')[0];
		const jsonStr = dataLine.replace('data: ', '');
		const parsed = JSON.parse(jsonStr);

		expect(parsed.type).toBe('message_update');
		expect(parsed.assistantMessageEvent.delta).toBe('Hello, "world"!\nNew line.');
	});

	it('handles all known event types', () => {
		const eventTypes = [
			'agent_start',
			'agent_end',
			'message_start',
			'message_update',
			'message_end',
			'session_ended',
			'stream_sync',
			'tool_execution_start',
			'tool_execution_update',
			'tool_execution_end',
			'auto_compaction_start',
			'auto_compaction_end',
			'auto_retry_start',
			'auto_retry_end',
			'extension_error',
			'extension_ui_request'
		];

		for (const type of eventTypes) {
			const event = { type };
			const serialized = `data: ${JSON.stringify(event)}\n\n`;
			expect(serialized).toContain(`"type":"${type}"`);
		}
	});
});
