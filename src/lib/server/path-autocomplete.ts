import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';

export const MAX_SUGGESTIONS = 20;

/**
 * Given a partial filesystem path typed by the user, returns up to
 * MAX_SUGGESTIONS absolute paths that begin with that prefix.
 * Directories are returned with a trailing slash so the user can keep typing.
 */
export function listPathSuggestions(partial: string): string[] {
	if (!partial) return [];

	// Expand leading ~ to the home directory
	const expanded = partial.startsWith('~')
		? partial.replace('~', process.env.HOME ?? '')
		: partial;

	// Determine the parent directory and the partially-typed final segment
	let parentDir: string;
	let prefix: string;

	if (expanded.endsWith('/')) {
		parentDir = expanded;
		prefix = '';
	} else {
		parentDir = dirname(expanded);
		prefix = basename(expanded);
	}

	const resolvedParent = resolve(parentDir);

	if (!existsSync(resolvedParent)) return [];

	let entries: string[];
	try {
		entries = readdirSync(resolvedParent);
	} catch {
		// Permission denied or not a directory
		return [];
	}

	const results: string[] = [];
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		// Hide dot-files unless the user explicitly types a dot
		if (entry.startsWith('.') && !prefix.startsWith('.')) continue;

		try {
			const fullPath = `${resolvedParent}/${entry}`;
			const stat = statSync(fullPath);
			// Append trailing slash for directories
			results.push(stat.isDirectory() ? `${fullPath}/` : fullPath);
		} catch {
			// Skip entries we can't stat (e.g. broken symlinks, race conditions)
		}

		if (results.length >= MAX_SUGGESTIONS) break;
	}

	return results.sort();
}
