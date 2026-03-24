/**
 * Server origin singleton — captured from the first incoming request
 * so that background services can build correct URLs without relying
 * on environment variables.
 *
 * Falls back to PI_REMOTE_HOST env var, then http://localhost:4020.
 */

const FALLBACK_HOST = process.env.PI_REMOTE_HOST || 'http://localhost:4020';

// Survive Vite HMR module re-evaluation
const g = globalThis as any;
if (g.__piServerOrigin === undefined) g.__piServerOrigin = '';

/**
 * Set the server origin (called once from hooks.server.ts).
 */
export function setOrigin(origin: string): void {
	g.__piServerOrigin = origin;
}

/**
 * Get the server origin. Returns the captured origin from the first request,
 * falling back to PI_REMOTE_HOST or http://localhost:4020.
 */
export function getOrigin(): string {
	return g.__piServerOrigin || FALLBACK_HOST;
}
