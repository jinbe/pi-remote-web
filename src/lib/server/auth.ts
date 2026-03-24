/**
 * Authentication helpers.
 *
 * When the `PI_AUTH_PASSWORD` environment variable is set, all requests
 * require a valid session cookie. The password can be supplied as either:
 *
 *   - **plaintext** — compared via constant-time equality
 *   - **bcrypt hash** — any string starting with `$2` is treated as a bcrypt
 *     digest and verified with `Bun.password.verify`
 *
 * A successful login creates an HMAC-signed session token stored in a
 * secure, httpOnly cookie.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'pi_auth';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Derive a signing key from the configured password so we don't need a
 * separate secret env var. The key is deterministic for a given password
 * so that existing cookies survive server restarts.
 */
function getSigningKey(): Buffer {
	const password = getPassword();
	if (!password) throw new Error('No password configured');
	return Buffer.from(
		createHmac('sha256', 'pi-auth-signing-key').update(password).digest()
	);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Returns the configured password, or `null` if auth is disabled. */
export function getPassword(): string | null {
	return process.env.PI_AUTH_PASSWORD?.trim() || null;
}

/** Whether authentication is enabled. */
export function isAuthEnabled(): boolean {
	return getPassword() !== null;
}

/** Returns `true` if `candidate` matches the configured password. */
export async function verifyPassword(candidate: string): Promise<boolean> {
	const stored = getPassword();
	if (!stored) return false;

	// Bcrypt hash — starts with $2a$, $2b$, or $2y$
	if (stored.startsWith('$2')) {
		return Bun.password.verify(candidate, stored);
	}

	// Plaintext — constant-time comparison
	const a = Buffer.from(candidate);
	const b = Buffer.from(stored);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Create a signed session token. */
export function createSessionToken(): string {
	const payload = randomBytes(32).toString('hex');
	const sig = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
	return `${payload}.${sig}`;
}

/** Validate a session token's signature. */
export function verifySessionToken(token: string): boolean {
	const dotIdx = token.indexOf('.');
	if (dotIdx === -1) return false;

	const payload = token.slice(0, dotIdx);
	const sig = token.slice(dotIdx + 1);

	const expectedSig = createHmac('sha256', getSigningKey()).update(payload).digest('hex');

	const sigBuf = Buffer.from(sig, 'hex');
	const expectedBuf = Buffer.from(expectedSig, 'hex');
	if (sigBuf.length !== expectedBuf.length) return false;

	return timingSafeEqual(sigBuf, expectedBuf);
}

/** Build a Set-Cookie header value for a successful login. */
export function buildAuthCookie(token: string, secure: boolean): string {
	const parts = [
		`${COOKIE_NAME}=${token}`,
		`Path=/`,
		`HttpOnly`,
		`SameSite=Lax`,
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	];
	if (secure) parts.push('Secure');
	return parts.join('; ');
}

/** Build a Set-Cookie header that clears the auth cookie. */
export function buildClearAuthCookie(): string {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Extract the auth token from a Cookie header string. */
export function getTokenFromCookies(cookieHeader: string | null): string | null {
	if (!cookieHeader) return null;
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
	return match?.[1] ?? null;
}

/** Cookie name — exported for tests. */
export { COOKIE_NAME };
