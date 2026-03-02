import { decodeSessionId } from '$lib/server/session-scanner';
import { getDb } from '$lib/server/cache';
import { json, error } from '@sveltejs/kit';
import { unlink } from 'fs/promises';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const filePath = decodeSessionId(params.id);

		// Delete the actual JSONL file
		await unlink(filePath);

		// Clean up cache entries
		const db = getDb();
		db.run('DELETE FROM session_meta WHERE file_path = ?', [filePath]);
		db.run('DELETE FROM session_messages WHERE file_path = ?', [filePath]);
		db.run('DELETE FROM active_sessions WHERE file_path = ?', [filePath]);

		return json({ ok: true });
	} catch (e: any) {
		if (e?.code === 'ENOENT') {
			// File already gone, clean up cache anyway
			try {
				const filePath = decodeSessionId(params.id);
				const db = getDb();
				db.run('DELETE FROM session_meta WHERE file_path = ?', [filePath]);
				db.run('DELETE FROM session_messages WHERE file_path = ?', [filePath]);
				db.run('DELETE FROM active_sessions WHERE file_path = ?', [filePath]);
			} catch { /* ignore */ }
			return json({ ok: true });
		}
		throw error(500, `Failed to delete session: ${e}`);
	}
};
