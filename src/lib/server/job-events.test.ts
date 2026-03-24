import { describe, test, expect, mock } from 'bun:test';
import { emitJobEvent, onJobEvent, type JobEvent } from './job-events';

describe('job-events', () => {
	test('subscriber receives emitted events', () => {
		const received: JobEvent[] = [];
		const unsubscribe = onJobEvent((event) => received.push(event));

		emitJobEvent({ type: 'job_created', jobId: 'test-1', status: 'queued' });
		emitJobEvent({ type: 'job_updated', jobId: 'test-1', status: 'running' });

		expect(received).toEqual([
			{ type: 'job_created', jobId: 'test-1', status: 'queued' },
			{ type: 'job_updated', jobId: 'test-1', status: 'running' },
		]);

		unsubscribe();
	});

	test('unsubscribed callback no longer receives events', () => {
		const received: JobEvent[] = [];
		const unsubscribe = onJobEvent((event) => received.push(event));

		emitJobEvent({ type: 'job_created', jobId: 'test-2', status: 'queued' });
		unsubscribe();
		emitJobEvent({ type: 'job_updated', jobId: 'test-2', status: 'running' });

		expect(received).toEqual([
			{ type: 'job_created', jobId: 'test-2', status: 'queued' },
		]);
	});

	test('multiple subscribers all receive events', () => {
		const received1: JobEvent[] = [];
		const received2: JobEvent[] = [];
		const unsub1 = onJobEvent((event) => received1.push(event));
		const unsub2 = onJobEvent((event) => received2.push(event));

		emitJobEvent({ type: 'job_deleted', jobId: 'test-3' });

		expect(received1).toEqual([{ type: 'job_deleted', jobId: 'test-3' }]);
		expect(received2).toEqual([{ type: 'job_deleted', jobId: 'test-3' }]);

		unsub1();
		unsub2();
	});

	test('emitting with no subscribers does not throw', () => {
		expect(() => {
			emitJobEvent({ type: 'job_created', jobId: 'test-4', status: 'queued' });
		}).not.toThrow();
	});
});
