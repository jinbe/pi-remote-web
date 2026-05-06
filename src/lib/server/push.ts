/**
 * Web Push helpers: VAPID key bootstrap, subscription storage, and a
 * fire-and-forget notify() call used by the task system.
 *
 * Keys are persisted in app_settings so they survive restarts and stay
 * stable for already-subscribed browsers. They are generated lazily on
 * first use of getVapidKeys().
 */
import webPush from 'web-push';
import { getDb } from './cache';
import { getSetting, setSetting } from './app-settings';
import { log } from './logger';

const VAPID_SUBJECT = process.env.PI_VAPID_SUBJECT ?? 'mailto:pi-dashboard@local';

interface PushSubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	created_at: string;
	last_seen_at: string;
}

export interface PushSubscriptionPayload {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface NotifyPayload {
	title: string;
	body: string;
	url?: string;
	tag?: string;
}

let _vapidConfigured = false;

/**
 * Lazy-init the VAPID keys. Generates a fresh keypair on first call and
 * persists it in app_settings. Subsequent calls reuse the stored keys so
 * existing browser subscriptions remain valid across server restarts.
 */
export function getVapidKeys(): { publicKey: string; privateKey: string } {
	let publicKey = getSetting('vapid_public_key');
	let privateKey = getSetting('vapid_private_key');

	if (!publicKey || !privateKey) {
		const generated = webPush.generateVAPIDKeys();
		publicKey = generated.publicKey;
		privateKey = generated.privateKey;
		setSetting('vapid_public_key', publicKey);
		setSetting('vapid_private_key', privateKey);
		log.info('push', 'generated and persisted new VAPID keypair');
	}

	if (!_vapidConfigured) {
		webPush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
		_vapidConfigured = true;
	}
	return { publicKey, privateKey };
}

export function getVapidPublicKey(): string {
	return getVapidKeys().publicKey;
}

// --- Subscription storage ---

export function upsertSubscription(sub: PushSubscriptionPayload, userAgent?: string): void {
	getDb().run(
		`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent),
		   last_seen_at = datetime('now')`,
		[sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent ?? null],
	);
}

export function deleteSubscription(endpoint: string): void {
	getDb().run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

function listSubscriptions(): PushSubscriptionRow[] {
	return getDb().query('SELECT * FROM push_subscriptions').all() as PushSubscriptionRow[];
}

// --- Notify ---

/**
 * Send a push to every subscribed device. Errors are logged but don't throw —
 * call sites are firing notifications as a side-effect of state transitions
 * and should not be blocked. Subscriptions that come back as 410/404 (gone)
 * are pruned.
 */
export async function notify(payload: NotifyPayload): Promise<void> {
	let subs: PushSubscriptionRow[];
	try {
		getVapidKeys(); // ensure configured
		subs = listSubscriptions();
	} catch (err) {
		log.warn('push', `notify init failed: ${err}`);
		return;
	}

	if (subs.length === 0) return;

	const body = JSON.stringify(payload);
	await Promise.all(subs.map(async (s) => {
		try {
			await webPush.sendNotification(
				{ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
				body,
			);
		} catch (err: any) {
			const code = err?.statusCode ?? err?.status ?? 0;
			if (code === 404 || code === 410) {
				log.info('push', `pruning gone subscription ${s.endpoint.slice(0, 60)}…`);
				deleteSubscription(s.endpoint);
			} else {
				log.warn('push', `send failed for ${s.endpoint.slice(0, 60)}…: ${err?.message ?? err}`);
			}
		}
	}));
}
