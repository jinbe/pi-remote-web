/**
 * Key/value store for global app settings (e.g. personal review prompt).
 * Backed by the `app_settings` table in the dashboard SQLite cache.
 */
import { getDb } from './cache';

export type SettingKey = 'personal_review_prompt';

export function getSetting(key: SettingKey): string {
	const row = getDb()
		.query('SELECT value FROM app_settings WHERE key = ?')
		.get(key) as { value: string } | null;
	return row?.value ?? '';
}

export function setSetting(key: SettingKey, value: string): void {
	const trimmed = value.trim();
	if (!trimmed) {
		getDb().run('DELETE FROM app_settings WHERE key = ?', [key]);
		return;
	}
	getDb().run(
		'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		[key, trimmed]
	);
}
