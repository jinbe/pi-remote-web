// Web Push service worker.
// Registered by client-side push helper; receives 'push' events and renders
// notifications. Click events focus or open the configured URL.

self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
	let payload = { title: 'Pi', body: '', url: '/', tag: undefined };
	if (event.data) {
		try {
			payload = { ...payload, ...event.data.json() };
		} catch {
			payload.body = event.data.text();
		}
	}
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag,
			data: { url: payload.url },
			badge: '/favicon.png',
			icon: '/favicon.png',
		}),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = event.notification.data?.url ?? '/';
	event.waitUntil((async () => {
		const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		// Focus an existing tab pointing at the URL if any.
		for (const c of all) {
			try {
				if (new URL(c.url).pathname === new URL(url, self.registration.scope).pathname) {
					return c.focus();
				}
			} catch {
				// ignore parse errors
			}
		}
		// Otherwise open a new one.
		return self.clients.openWindow(url);
	})());
});
