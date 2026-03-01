<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="flex min-h-screen items-center justify-center">
	<div class="text-center">
		<h1 class="text-6xl font-bold text-error">{page.status}</h1>
		<p class="mt-4 text-lg text-base-content/60">{page.error?.message || 'Something went wrong'}</p>
		<a href="/" class="btn btn-primary mt-6">Back to Sessions</a>
	</div>
</div>
