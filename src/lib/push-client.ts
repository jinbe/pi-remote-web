/**
 * Client-side Web Push helpers. Registers the service worker and the browser
 * subscription against the server. Call enablePush() from the worktrees page
 * (or any user-gesture handler) to prompt for permission and subscribe.
 */
const SW_PATH = '/push-sw.js';

export type PushState = 'unsupported' | 'denied' | 'unsubscribed' | 'subscribed';

export async function getPushState(): Promise<PushState> {
	if (typeof window === 'undefined') return 'unsupported';
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
	if (Notification.permission === 'denied') return 'denied';

	const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
	if (!reg) return 'unsubscribed';
	const sub = await reg.pushManager.getSubscription();
	return sub ? 'subscribed' : 'unsubscribed';
}

/**
 * Prompt for notification permission and subscribe to push. Returns true if
 * the browser is now subscribed.
 */
export async function enablePush(): Promise<boolean> {
	if (typeof window === 'undefined') return false;
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return false;

	const reg = await navigator.serviceWorker.register(SW_PATH);
	await navigator.serviceWorker.ready;

	const keyRes = await fetch('/api/push/vapid-key');
	const { publicKey } = await keyRes.json();
	const sub = await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
	});

	const json = sub.toJSON();
	await fetch('/api/push/subscribe', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
	});
	return true;
}

export async function disablePush(): Promise<void> {
	const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
	const sub = await reg?.pushManager.getSubscription();
	if (sub) {
		try {
			await fetch('/api/push/subscribe', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ endpoint: sub.endpoint }),
			});
		} catch {
			// ignore
		}
		await sub.unsubscribe();
	}
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(b64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}
