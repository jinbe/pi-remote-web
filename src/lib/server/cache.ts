import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { onFileChanged } from './session-watcher';

const DB_PATH = join(homedir(), '.pi', 'dashboard-cache.sqlite');

let db: Database;

export function getDb(): Database {
	if (!db) {
		db = new Database(DB_PATH);
		db.run('PRAGMA journal_mode = WAL');
		db.run('PRAGMA synchronous = NORMAL');
		db.run('PRAGMA cache_size = -64000');

		db.run(`CREATE TABLE IF NOT EXISTS session_meta (
			file_path     TEXT PRIMARY KEY,
			mtime_ms      INTEGER NOT NULL,
			size_bytes    INTEGER NOT NULL,
			cwd           TEXT NOT NULL,
			name          TEXT,
			first_message TEXT,
			model         TEXT,
			message_count INTEGER NOT NULL,
			last_modified TEXT NOT NULL,
			created_at    TEXT NOT NULL
		)`);

		db.run(`CREATE TABLE IF NOT EXISTS session_messages (
			file_path     TEXT PRIMARY KEY,
			mtime_ms      INTEGER NOT NULL,
			size_bytes    INTEGER NOT NULL,
			messages_json TEXT NOT NULL,
			tree_json     TEXT NOT NULL
		)`);

		db.run(`CREATE TABLE IF NOT EXISTS active_sessions (
			session_id    TEXT PRIMARY KEY,
			file_path     TEXT NOT NULL,
			cwd           TEXT NOT NULL,
			pid           INTEGER,
			started_at    TEXT NOT NULL,
			last_event_at TEXT,
			model         TEXT,
			status        TEXT NOT NULL DEFAULT 'starting'
		)`);

		db.run(`CREATE TABLE IF NOT EXISTS favorite_projects (
			cwd TEXT PRIMARY KEY
		)`);

		db.run('CREATE INDEX IF NOT EXISTS idx_meta_mtime ON session_meta(mtime_ms)');
		db.run('CREATE INDEX IF NOT EXISTS idx_meta_last_modified ON session_meta(last_modified)');
		db.run('CREATE INDEX IF NOT EXISTS idx_active_status ON active_sessions(status)');
	}
	return db;
}

// Favorite projects
export function getFavoriteProjects(): Set<string> {
	const rows = getDb().query('SELECT cwd FROM favorite_projects').all() as { cwd: string }[];
	return new Set(rows.map((r) => r.cwd));
}

export function addFavoriteProject(cwd: string) {
	getDb().run('INSERT OR IGNORE INTO favorite_projects (cwd) VALUES (?)', [cwd]);
}

export function removeFavoriteProject(cwd: string) {
	getDb().run('DELETE FROM favorite_projects WHERE cwd = ?', [cwd]);
}

// Prepared statements — initialized lazily after getDb()
let _getMetaStmt: ReturnType<Database['query']>;
let _upsertMetaStmt: ReturnType<Database['query']>;
let _getMsgsStmt: ReturnType<Database['query']>;
let _upsertMsgsStmt: ReturnType<Database['query']>;

export function getMetaStmt() {
	if (!_getMetaStmt) _getMetaStmt = getDb().query('SELECT * FROM session_meta WHERE file_path = ?');
	return _getMetaStmt;
}

export function upsertMetaStmt() {
	if (!_upsertMetaStmt)
		_upsertMetaStmt = getDb().query(`
		INSERT OR REPLACE INTO session_meta
		(file_path, mtime_ms, size_bytes, cwd, name, first_message, model, message_count, last_modified, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	return _upsertMetaStmt;
}

export function getMsgsStmt() {
	if (!_getMsgsStmt)
		_getMsgsStmt = getDb().query('SELECT * FROM session_messages WHERE file_path = ?');
	return _getMsgsStmt;
}

export function upsertMsgsStmt() {
	if (!_upsertMsgsStmt)
		_upsertMsgsStmt = getDb().query(`
		INSERT OR REPLACE INTO session_messages
		(file_path, mtime_ms, size_bytes, messages_json, tree_json)
		VALUES (?, ?, ?, ?, ?)
	`);
	return _upsertMsgsStmt;
}

// Cache invalidation via file watcher
let watcherRegistered = false;
export function registerCacheInvalidation() {
	if (watcherRegistered) return;
	watcherRegistered = true;
	onFileChanged((filePath: string) => {
		const d = getDb();
		d.run('UPDATE session_meta SET mtime_ms = 0 WHERE file_path = ?', [filePath]);
		d.run('UPDATE session_messages SET mtime_ms = 0 WHERE file_path = ?', [filePath]);
	});
}

export function pruneCache() {
	const d = getDb();
	const cached = d.query('SELECT file_path FROM session_meta').all() as { file_path: string }[];
	for (const row of cached) {
		if (!existsSync(row.file_path)) {
			d.run('DELETE FROM session_meta WHERE file_path = ?', [row.file_path]);
			d.run('DELETE FROM session_messages WHERE file_path = ?', [row.file_path]);
		}
	}
}

export function warmCache(scanAndParse: () => Promise<void>) {
	setTimeout(() => scanAndParse(), 100);
}
