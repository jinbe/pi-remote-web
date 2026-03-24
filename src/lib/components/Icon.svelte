<!--
  Centralised SVG icon component.
  Usage: <Icon name="cog" class="w-4 h-4" />
-->
<script lang="ts">
	export type IconName = 'clock' | 'lock' | 'bolt' | 'hammer' | 'search' | 'target' | 'paperclip' | 'cog' | 'document' | 'pencil' | 'save' | 'sun' | 'moon' | 'circle-green' | 'circle-red' | 'check-circle' | 'play-pause' | 'stop-circle' | 'play' | 'stop' | 'compress';
	let { name, class: className = 'w-4 h-4' }: { name: IconName; class?: string } = $props();
</script>

{#if name === 'clock'}
	<!-- ⏳ Queued / waiting -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
	</svg>
{:else if name === 'lock'}
	<!-- 🔒 Claimed / locked -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
	</svg>
{:else if name === 'bolt'}
	<!-- ⚡ Running / bash / steer -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
	</svg>
{:else if name === 'hammer'}
	<!-- ⚒ Task -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
	</svg>
{:else if name === 'search'}
	<!-- 🔍 Review / search / LSP -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
	</svg>
{:else if name === 'target'}
	<!-- 🎯 Skill / target -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
	</svg>
{:else if name === 'paperclip'}
	<!-- 📎 Attach -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
	</svg>
{:else if name === 'cog'}
	<!-- 🔧 Tool -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
		<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
	</svg>
{:else if name === 'document'}
	<!-- 📄 Read / file -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
	</svg>
{:else if name === 'pencil'}
	<!-- ✏️ Edit -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
	</svg>
{:else if name === 'save'}
	<!-- 💾 Write / save -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
	</svg>
{:else if name === 'sun'}
	<!-- ☀️ Light theme -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
	</svg>
{:else if name === 'moon'}
	<!-- 🌙 Dark theme -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
	</svg>
{:else if name === 'circle-green'}
	<!-- 🟢 Session created -->
	<svg class={className} viewBox="0 0 24 24" fill="currentColor">
		<circle cx="12" cy="12" r="6" />
	</svg>
{:else if name === 'circle-red'}
	<!-- 🔴 Session ended -->
	<svg class={className} viewBox="0 0 24 24" fill="currentColor">
		<circle cx="12" cy="12" r="6" />
	</svg>
{:else if name === 'check-circle'}
	<!-- ✅ Compaction done -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
	</svg>
{:else if name === 'play-pause'}
	<!-- ⏯️ Session resumed -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
		<path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
	</svg>
{:else if name === 'stop-circle'}
	<!-- 🛑 Session stopped -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
		<path stroke-linecap="round" stroke-linejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
	</svg>
{:else if name === 'play'}
	<!-- ▶️ Agent start -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
	</svg>
{:else if name === 'stop'}
	<!-- ⏹️ Agent end -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M6 6h12v12H6z" />
	</svg>
{:else if name === 'compress'}
	<!-- 🗜️ Compaction start -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
	</svg>
{:else}
	<!-- Fallback for unrecognised icon names -->
	<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
		<circle cx="12" cy="12" r="10" />
		<path stroke-linecap="round" stroke-linejoin="round" d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3m.08 4h.01" />
	</svg>
{/if}
