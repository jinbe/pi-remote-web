import { decodeSessionId, parseSessionMetadata } from '$lib/server/session-scanner';
import { getActiveSession } from '$lib/server/rpc-manager';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const MAX_DIFF_BYTES = 512 * 1024; // 512KB cap

async function runGit(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return text;
}

export const GET: RequestHandler = async ({ params }) => {
	const filePath = decodeSessionId(params.id);

	// Resolve cwd from metadata or active session
	let cwd = '';
	try {
		const meta = await parseSessionMetadata(filePath);
		cwd = meta.cwd;
	} catch {
		const info = getActiveSession(params.id);
		cwd = info?.cwd ?? '';
	}

	if (!cwd) {
		throw error(400, 'No working directory for this session');
	}

	// Check if it's a git repo
	const checkProc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const isGit = (await new Response(checkProc.stdout).text()).trim();
	await checkProc.exited;

	if (isGit !== 'true') {
		return json({ isGitRepo: false, files: [], diff: '' });
	}

	// Get branch name
	const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();

	// Get combined diff: unstaged + staged changes
	const [unstaged, staged] = await Promise.all([
		runGit(['diff', '--no-color'], cwd),
		runGit(['diff', '--cached', '--no-color'], cwd)
	]);

	let diff = '';
	if (staged && unstaged) {
		diff = `${staged}\n${unstaged}`;
	} else {
		diff = staged || unstaged;
	}

	// Get list of changed files with status
	const [unstagedFiles, stagedFiles, untrackedRaw] = await Promise.all([
		runGit(['diff', '--name-status'], cwd),
		runGit(['diff', '--cached', '--name-status'], cwd),
		runGit(['ls-files', '--others', '--exclude-standard'], cwd)
	]);

	// Parse file statuses
	const fileMap = new Map<string, string>();

	for (const line of stagedFiles.split('\n')) {
		if (!line.trim()) continue;
		const [status, ...rest] = line.split('\t');
		const file = rest.join('\t');
		fileMap.set(file, `staged:${status}`);
	}

	for (const line of unstagedFiles.split('\n')) {
		if (!line.trim()) continue;
		const [status, ...rest] = line.split('\t');
		const file = rest.join('\t');
		const existing = fileMap.get(file);
		if (existing) {
			fileMap.set(file, `${existing}+${status}`);
		} else {
			fileMap.set(file, status);
		}
	}

	const untrackedFiles: string[] = [];
	for (const line of untrackedRaw.split('\n')) {
		if (!line.trim()) continue;
		const file = line.trim();
		fileMap.set(file, '?');
		untrackedFiles.push(file);
	}

	const files = Array.from(fileMap.entries()).map(([name, status]) => ({ name, status }));

	// Generate pseudo-diffs for untracked (new) files so they appear in the viewer
	for (const file of untrackedFiles) {
		try {
			const content = await Bun.file(`${cwd}/${file}`).text();
			const lines = content.split('\n');
			const header = `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
			const body = lines.map((l) => `+${l}`).join('\n');
			diff += `\n${header}${body}\n`;
		} catch {
			// Skip binary or unreadable files
		}
	}

	// Truncate if too large
	const truncated = diff.length > MAX_DIFF_BYTES;
	if (truncated) {
		diff = diff.slice(0, MAX_DIFF_BYTES);
	}

	// Get short stat summary
	const stat = (await runGit(['diff', '--stat', '--no-color', 'HEAD'], cwd)).trim();

	return json({
		isGitRepo: true,
		branch,
		files,
		diff,
		stat,
		truncated
	});
};
