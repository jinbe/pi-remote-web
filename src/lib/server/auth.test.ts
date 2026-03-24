import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
	getPassword,
	isAuthEnabled,
	verifyPassword,
	createSessionToken,
	verifySessionToken,
	buildAuthCookie,
	buildClearAuthCookie,
	getTokenFromCookies,
	COOKIE_NAME,
} from './auth';

describe('auth', () => {
	const originalEnv = process.env.PI_AUTH_PASSWORD;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_AUTH_PASSWORD;
		} else {
			process.env.PI_AUTH_PASSWORD = originalEnv;
		}
	});

	describe('getPassword / isAuthEnabled', () => {
		it('returns null when env var is not set', () => {
			delete process.env.PI_AUTH_PASSWORD;
			expect(getPassword()).toBeNull();
			expect(isAuthEnabled()).toBe(false);
		});

		it('returns null when env var is empty or whitespace', () => {
			process.env.PI_AUTH_PASSWORD = '   ';
			expect(getPassword()).toBeNull();
			expect(isAuthEnabled()).toBe(false);
		});

		it('returns the trimmed password when set', () => {
			process.env.PI_AUTH_PASSWORD = '  secret123  ';
			expect(getPassword()).toBe('secret123');
			expect(isAuthEnabled()).toBe(true);
		});
	});

	describe('verifyPassword — plaintext', () => {
		beforeEach(() => {
			process.env.PI_AUTH_PASSWORD = 'my-secret';
		});

		it('returns true for correct password', async () => {
			expect(await verifyPassword('my-secret')).toBe(true);
		});

		it('returns false for incorrect password', async () => {
			expect(await verifyPassword('wrong')).toBe(false);
		});

		it('returns false for empty input', async () => {
			expect(await verifyPassword('')).toBe(false);
		});

		it('returns false when no password is configured', async () => {
			delete process.env.PI_AUTH_PASSWORD;
			expect(await verifyPassword('anything')).toBe(false);
		});
	});

	describe('verifyPassword — bcrypt', () => {
		// Pre-computed bcrypt hash for "test-password"
		let bcryptHash: string;

		beforeEach(async () => {
			bcryptHash = await Bun.password.hash('test-password', { algorithm: 'bcrypt' });
			process.env.PI_AUTH_PASSWORD = bcryptHash;
		});

		it('returns true for correct password', async () => {
			expect(await verifyPassword('test-password')).toBe(true);
		});

		it('returns false for incorrect password', async () => {
			expect(await verifyPassword('wrong-password')).toBe(false);
		});
	});

	describe('session tokens', () => {
		beforeEach(() => {
			process.env.PI_AUTH_PASSWORD = 'token-test-secret';
		});

		it('creates a valid token with payload.signature format', () => {
			const token = createSessionToken();
			expect(token).toContain('.');
			expect(token.split('.').length).toBe(2);
		});

		it('verifies a valid token', () => {
			const token = createSessionToken();
			expect(verifySessionToken(token)).toBe(true);
		});

		it('rejects a tampered payload', () => {
			const token = createSessionToken();
			const [payload, sig] = token.split('.');
			// Flip the entire payload to something different
			const flipped = payload.split('').map(c => c === 'a' ? 'b' : 'a').join('');
			expect(verifySessionToken(`${flipped}.${sig}`)).toBe(false);
		});

		it('rejects a tampered signature', () => {
			const token = createSessionToken();
			const [payload, sig] = token.split('.');
			const flipped = sig.split('').map(c => c === 'a' ? 'b' : 'a').join('');
			expect(verifySessionToken(`${payload}.${flipped}`)).toBe(false);
		});

		it('rejects a token without a dot', () => {
			expect(verifySessionToken('nodothere')).toBe(false);
		});

		it('rejects an empty string', () => {
			expect(verifySessionToken('')).toBe(false);
		});

		it('tokens from different passwords are invalid', () => {
			const token = createSessionToken();
			process.env.PI_AUTH_PASSWORD = 'different-password';
			expect(verifySessionToken(token)).toBe(false);
		});
	});

	describe('cookie helpers', () => {
		it('buildAuthCookie includes all required attributes', () => {
			const cookie = buildAuthCookie('my-token', false);
			expect(cookie).toContain(`${COOKIE_NAME}=my-token`);
			expect(cookie).toContain('Path=/');
			expect(cookie).toContain('HttpOnly');
			expect(cookie).toContain('SameSite=Lax');
			expect(cookie).toContain('Max-Age=');
			expect(cookie).not.toContain('Secure');
		});

		it('buildAuthCookie includes Secure flag when requested', () => {
			const cookie = buildAuthCookie('my-token', true);
			expect(cookie).toContain('Secure');
		});

		it('buildClearAuthCookie sets Max-Age=0', () => {
			const cookie = buildClearAuthCookie();
			expect(cookie).toContain(`${COOKIE_NAME}=`);
			expect(cookie).toContain('Max-Age=0');
		});
	});

	describe('getTokenFromCookies', () => {
		it('returns null for null header', () => {
			expect(getTokenFromCookies(null)).toBeNull();
		});

		it('extracts token from a single cookie', () => {
			expect(getTokenFromCookies(`${COOKIE_NAME}=abc123`)).toBe('abc123');
		});

		it('extracts token from multiple cookies', () => {
			const header = `other=foo; ${COOKIE_NAME}=abc123; another=bar`;
			expect(getTokenFromCookies(header)).toBe('abc123');
		});

		it('returns null when cookie is not present', () => {
			expect(getTokenFromCookies('other=foo; bar=baz')).toBeNull();
		});
	});
});
