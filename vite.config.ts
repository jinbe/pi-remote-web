import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const DEFAULT_PORT = 4020;

export default defineConfig({
	plugins: [sveltekit(), tailwindcss()],
	server: {
		port: DEFAULT_PORT,
	},
	preview: {
		port: DEFAULT_PORT,
	},
	ssr: {
		external: ['bun:sqlite']
	}
});
