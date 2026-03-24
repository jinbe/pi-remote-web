import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { timeAgo, truncatePath } from './utils';

describe('timeAgo', () => {
	let originalDateNow: typeof Date.now;

	beforeEach(() => {
		originalDateNow = Date.now;
	});

	afterEach(() => {
		Date.now = originalDateNow;
	});

	it('returns "just now" for recent timestamps', () => {
		Date.now = () => new Date('2025-01-15T12:00:30Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('just now');
	});

	it('returns minutes ago', () => {
		Date.now = () => new Date('2025-01-15T12:05:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('5m ago');
	});

	it('returns hours ago', () => {
		Date.now = () => new Date('2025-01-15T15:00:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('3h ago');
	});

	it('returns days ago', () => {
		Date.now = () => new Date('2025-01-18T12:00:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('3d ago');
	});

	it('returns "just now" for timestamps less than 60 seconds ago', () => {
		Date.now = () => new Date('2025-01-15T12:00:59Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('just now');
	});

	it('returns 1m ago at exactly 60 seconds', () => {
		Date.now = () => new Date('2025-01-15T12:01:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('1m ago');
	});

	it('returns 1h ago at exactly 60 minutes', () => {
		Date.now = () => new Date('2025-01-15T13:00:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('1h ago');
	});

	it('returns 1d ago at exactly 24 hours', () => {
		Date.now = () => new Date('2025-01-16T12:00:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('1d ago');
	});

	// SQLite datetime('now') returns UTC timestamps without a 'Z' suffix
	it('handles SQLite datetime format without timezone suffix', () => {
		Date.now = () => new Date('2025-01-15T15:00:00Z').getTime();
		expect(timeAgo('2025-01-15 12:00:00')).toBe('3h ago');
	});

	it('handles SQLite datetime format for minutes', () => {
		Date.now = () => new Date('2025-01-15T12:05:00Z').getTime();
		expect(timeAgo('2025-01-15 12:00:00')).toBe('5m ago');
	});

	it('handles SQLite datetime format for days', () => {
		Date.now = () => new Date('2025-01-18T12:00:00Z').getTime();
		expect(timeAgo('2025-01-15 12:00:00')).toBe('3d ago');
	});

	it('handles timestamps with explicit positive offset', () => {
		Date.now = () => new Date('2025-01-15T15:00:00Z').getTime();
		// 17:00:00+02:00 = 15:00:00Z, so diff is 0 seconds = just now
		expect(timeAgo('2025-01-15T17:00:00+02:00')).toBe('just now');
	});

	it('preserves existing Z suffix without doubling', () => {
		Date.now = () => new Date('2025-01-15T12:05:00Z').getTime();
		expect(timeAgo('2025-01-15T12:00:00Z')).toBe('5m ago');
	});
});

describe('truncatePath', () => {
	it('returns empty string for empty path', () => {
		expect(truncatePath('')).toBe('');
	});

	it('returns path as-is when shorter than maxLen', () => {
		expect(truncatePath('/short/path')).toBe('/short/path');
	});

	it('returns path as-is when exactly maxLen', () => {
		const path = 'a'.repeat(30);
		expect(truncatePath(path)).toBe(path);
	});

	it('truncates long paths with ellipsis prefix', () => {
		const path = '/very/long/path/that/exceeds/the/maximum/length/allowed';
		const result = truncatePath(path, 30);
		expect(result.length).toBe(30);
		expect(result.startsWith('…')).toBe(true);
		expect(path.endsWith(result.slice(1))).toBe(true);
	});

	it('uses custom maxLen', () => {
		const path = '/some/longer/path';
		const result = truncatePath(path, 10);
		expect(result.length).toBe(10);
		expect(result.startsWith('…')).toBe(true);
	});

	it('returns path as-is when exactly at custom maxLen', () => {
		expect(truncatePath('/12345', 6)).toBe('/12345');
	});

	it('handles undefined/null-ish paths', () => {
		expect(truncatePath(undefined as any)).toBe('');
		expect(truncatePath(null as any)).toBe('');
	});
});
