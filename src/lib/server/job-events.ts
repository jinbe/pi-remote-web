/**
 * Job event bus — emits events when job status changes.
 * Subscribers (e.g. SSE endpoints) receive notifications to push updates to clients.
 */

export type JobEventType = 'job_updated' | 'job_created' | 'job_deleted';

export interface JobEvent {
	type: JobEventType;
	jobId: string;
	status?: string;
}

const callbacks = new Set<(event: JobEvent) => void>();

/**
 * Emit a job event to all subscribers.
 */
export function emitJobEvent(event: JobEvent): void {
	for (const cb of callbacks) {
		cb(event);
	}
}

/**
 * Subscribe to job events. Returns an unsubscribe function.
 */
export function onJobEvent(callback: (event: JobEvent) => void): () => void {
	callbacks.add(callback);
	return () => callbacks.delete(callback);
}
