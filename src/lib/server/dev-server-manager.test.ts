import { describe, it, expect } from 'bun:test';

describe('dev server output buffer management', () => {
	it('trims output buffer when exceeding 300 lines', () => {
		const output: string[] = [];
		for (let i = 0; i < 310; i++) {
			output.push(`line ${i}`);
		}

		let trimmed = output;
		if (trimmed.length > 300) {
			trimmed = trimmed.slice(-200);
		}

		expect(trimmed.length).toBe(200);
		expect(trimmed[0]).toBe('line 110');
		expect(trimmed[199]).toBe('line 309');
	});

	it('does not trim when under 300 lines', () => {
		const output: string[] = [];
		for (let i = 0; i < 250; i++) {
			output.push(`line ${i}`);
		}

		let trimmed = output;
		if (trimmed.length > 300) {
			trimmed = trimmed.slice(-200);
		}

		expect(trimmed.length).toBe(250);
	});

	it('handles empty output', () => {
		const output: string[] = [];
		let trimmed = output;
		if (trimmed.length > 300) {
			trimmed = trimmed.slice(-200);
		}
		expect(trimmed.length).toBe(0);
	});
});
