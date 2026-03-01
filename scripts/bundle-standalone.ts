import { $ } from 'bun';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative } from 'path';

// Step 1: SvelteKit build
await $`bun --bun run build`;

// Step 2: Collect all client assets
function walkDir(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkDir(full));
		else files.push(full);
	}
	return files;
}

const clientDir = './build/client';
const assets = walkDir(clientDir).map((f) => ({
	path: '/' + relative(clientDir, f),
	content: readFileSync(f).toString('base64')
}));

writeFileSync('./build/embedded-assets.json', JSON.stringify(assets));

// Step 3: Create standalone entry
const standaloneEntry = `
import { handler } from './index.js';

const assetsJson = await Bun.file(import.meta.dir + '/embedded-assets.json').json();
const assets = new Map();
for (const a of assetsJson) {
	assets.set(a.path, Buffer.from(a.content, 'base64'));
}

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

Bun.serve({
	port: PORT,
	hostname: HOST,
	async fetch(req) {
		const url = new URL(req.url);

		// Serve embedded static assets
		const asset = assets.get(url.pathname);
		if (asset) {
			const ext = url.pathname.split('.').pop();
			const types: Record<string, string> = {
				js: 'application/javascript',
				css: 'text/css',
				html: 'text/html',
				json: 'application/json',
				png: 'image/png',
				svg: 'image/svg+xml',
				ico: 'image/x-icon',
			};
			return new Response(asset, {
				headers: { 'Content-Type': types[ext || ''] || 'application/octet-stream' }
			});
		}

		// Fall through to SvelteKit handler
		return handler(req);
	}
});

console.log(\`Pi Dashboard running at http://\${HOST}:\${PORT}\`);
`;

writeFileSync('./build/standalone-entry.ts', standaloneEntry);

// Step 4: Compile
mkdirSync('./dist', { recursive: true });
await $`bun build --compile ./build/standalone-entry.ts --outfile dist/pi-dashboard`;
console.log('✅ Built: dist/pi-dashboard');
