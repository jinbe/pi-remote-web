export function timeAgo(dateStr: string): string {
	const date = new Date(dateStr);
	const now = Date.now();
	const diff = now - date.getTime();
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

export function truncatePath(path: string, maxLen = 30): string {
	if (!path) return '';
	if (path.length <= maxLen) return path;
	return '…' + path.slice(path.length - maxLen + 1);
}

export function shortenHome(path: string): string {
	if (!path) return '';
	return path.replace(/^\/Users\/[^/]+\//, '~/');
}

/** Generate a unique ID. crypto.randomUUID() requires a secure context (HTTPS). */
export function uniqueId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
