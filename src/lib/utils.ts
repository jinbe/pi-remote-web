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
	const home = '~';
	let display = path;
	// Try to shorten home directory
	if (typeof window === 'undefined') {
		// server - don't shorten
	} else {
		// client — can't know home, just truncate
	}
	if (display.length > maxLen) {
		display = '…' + display.slice(display.length - maxLen + 1);
	}
	return display;
}
