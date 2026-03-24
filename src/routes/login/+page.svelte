<script lang="ts">
	import { enhance } from '$app/forms';
	import logoSvg from '$lib/assets/logo.svg';

	let { data, form } = $props();

	let submitting = $state(false);
	let passwordInput = $state<HTMLInputElement | undefined>();

	// Focus the password field on mount without using the autofocus attribute
	$effect(() => {
		passwordInput?.focus();
	});
</script>

<svelte:head>
	<title>Login — Pi Dashboard</title>
</svelte:head>

<div class="flex items-center justify-center h-full">
	<div class="card bg-base-200 shadow-xl w-full max-w-sm mx-4">
		<div class="card-body items-center text-center">
			<img src={logoSvg} alt="Pi" class="h-12 w-12 rounded-lg mb-2" />
			<h2 class="card-title">Pi Dashboard</h2>
			<p class="text-sm text-base-content/60 mb-4">Enter your password to continue</p>

			{#if form?.error}
				<div class="alert alert-error text-sm w-full">
					<span>{form.error}</span>
				</div>
			{/if}

			<form
				method="POST"
				class="w-full flex flex-col gap-4"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						submitting = false;
						await update();
					};
				}}
			>
				<input type="hidden" name="redirect" value={data.redirect} />

				<label class="form-control w-full">
					<input
						bind:this={passwordInput}
						type="password"
						name="password"
						placeholder="Password"
						class="input input-bordered w-full"
						required
					/>
				</label>

				<button
					type="submit"
					class="btn btn-primary w-full"
					disabled={submitting}
				>
					{#if submitting}
						<span class="loading loading-spinner loading-sm"></span>
					{/if}
					Sign in
				</button>
			</form>
		</div>
	</div>
</div>
