<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { setContext } from 'svelte';

	let { children } = $props();

	let theme = $state<'dark' | 'light'>(
		browser ? (localStorage.getItem('pi-theme') as 'dark' | 'light') || 'dark' : 'dark'
	);

	const daisyTheme = $derived(theme === 'dark' ? 'pi-dark' : 'pi-light');

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		if (browser) localStorage.setItem('pi-theme', theme);
	}

	setContext('theme', { get theme() { return theme; }, toggleTheme });

	// Mirror the theme onto <html> so html/body inherit theme CSS vars.
	// iOS PWA paints the home-indicator safe area from the body background,
	// not from inner fixed elements — without this, the system's default
	// dark-grey leaks through as a bar at the bottom.
	$effect(() => {
		if (browser) {
			document.documentElement.setAttribute('data-theme', daisyTheme);
		}
	});
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<meta name="theme-color" content={theme === 'dark' ? '#000000' : '#ffffff'} />
	<title>Pi Dashboard</title>
</svelte:head>

<div
	data-theme={daisyTheme}
	class="fixed inset-0 bg-base-100 text-base-content overflow-hidden overscroll-none"
	style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right);"
>
	{@render children()}
</div>
