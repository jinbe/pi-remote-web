import { describe, it, expect } from 'bun:test';

/**
 * Tests for the commands API response normalisation logic.
 *
 * The /api/sessions/[id]/commands endpoint normalises the RPC response from
 * pi's get_commands into a consistent { commands: [...] } shape. The RPC
 * result may arrive as:
 *   - An array directly: [{ name, description, source }, ...]
 *   - An object with a commands key: { commands: [...] }
 *   - Something unexpected (null, undefined, wrong shape)
 *
 * These tests validate the normalisation without needing a running server.
 */

// Reproduce the normalisation logic used in the commands endpoint and the
// client-side ensureCommands — both paths must agree on the shape.
function normaliseServerResult(result: any): any[] {
	return Array.isArray(result) ? result : (result?.commands ?? []);
}

function normaliseClientResponse(data: any): any[] {
	return Array.isArray(data.commands) ? data.commands : [];
}

describe('commands API normalisation', () => {
	describe('server-side (RPC result → response)', () => {
		it('handles an array result directly', () => {
			const result = [
				{ name: 'plan', description: 'Plan mode', source: 'extension' },
				{ name: 'help', description: 'Show help', source: 'skill' },
			];
			const commands = normaliseServerResult(result);
			expect(commands).toEqual(result);
			expect(commands).toHaveLength(2);
		});

		it('handles an object with commands key', () => {
			const result = {
				commands: [
					{ name: 'plan', description: 'Plan mode', source: 'extension' },
				],
			};
			const commands = normaliseServerResult(result);
			expect(commands).toEqual(result.commands);
			expect(commands).toHaveLength(1);
		});

		it('returns empty array for null result', () => {
			expect(normaliseServerResult(null)).toEqual([]);
		});

		it('returns empty array for undefined result', () => {
			expect(normaliseServerResult(undefined)).toEqual([]);
		});

		it('returns empty array for object without commands key', () => {
			expect(normaliseServerResult({ foo: 'bar' })).toEqual([]);
		});

		it('returns empty array for empty object', () => {
			expect(normaliseServerResult({})).toEqual([]);
		});

		it('returns empty array for string result', () => {
			expect(normaliseServerResult('unexpected')).toEqual([]);
		});

		it('returns empty array for numeric result', () => {
			expect(normaliseServerResult(42)).toEqual([]);
		});

		it('handles empty commands array in object', () => {
			expect(normaliseServerResult({ commands: [] })).toEqual([]);
		});

		it('handles empty array result', () => {
			expect(normaliseServerResult([])).toEqual([]);
		});
	});

	describe('client-side (fetch response → commands state)', () => {
		it('extracts commands from valid response', () => {
			const data = {
				commands: [
					{ name: 'plan', description: 'Plan mode', source: 'extension' },
					{ name: 'compact', source: 'skill' },
				],
			};
			const commands = normaliseClientResponse(data);
			expect(commands).toEqual(data.commands);
			expect(commands).toHaveLength(2);
		});

		it('returns empty array when commands is not an array', () => {
			expect(normaliseClientResponse({ commands: 'not-an-array' })).toEqual([]);
		});

		it('returns empty array when commands key is missing', () => {
			expect(normaliseClientResponse({})).toEqual([]);
		});

		it('returns empty array when commands is null', () => {
			expect(normaliseClientResponse({ commands: null })).toEqual([]);
		});

		it('returns empty array when commands is undefined', () => {
			expect(normaliseClientResponse({ commands: undefined })).toEqual([]);
		});

		it('handles empty commands array', () => {
			expect(normaliseClientResponse({ commands: [] })).toEqual([]);
		});
	});

	describe('end-to-end: server normalise → client normalise', () => {
		// Simulates the full path: RPC result → server normalisation → JSON response → client normalisation

		function roundTrip(rpcResult: any): any[] {
			// Server side: normalise RPC result and wrap in response
			const serverCommands = normaliseServerResult(rpcResult);
			const responseBody = { commands: serverCommands };

			// Client side: parse response and normalise
			return normaliseClientResponse(responseBody);
		}

		it('preserves commands from array RPC result', () => {
			const cmds = [{ name: 'plan', description: 'Plan', source: 'extension' as const }];
			expect(roundTrip(cmds)).toEqual(cmds);
		});

		it('preserves commands from object RPC result', () => {
			const cmds = [{ name: 'help', source: 'skill' as const }];
			expect(roundTrip({ commands: cmds })).toEqual(cmds);
		});

		it('returns empty array for null RPC result', () => {
			expect(roundTrip(null)).toEqual([]);
		});

		it('returns empty array for unexpected RPC result', () => {
			expect(roundTrip('error')).toEqual([]);
		});
	});
});
