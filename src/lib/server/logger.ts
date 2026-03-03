import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const LOG_DIR = join(tmpdir(), 'pi-remote-web');
const LOG_FILE = join(LOG_DIR, 'debug.log');

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function timestamp(): string {
	return new Date().toISOString();
}

function write(level: string, tag: string, ...args: any[]) {
	const msg = args.map(a =>
		typeof a === 'string' ? a : JSON.stringify(a, null, 0)
	).join(' ');
	const line = `${timestamp()} [${level}] [${tag}] ${msg}\n`;
	try {
		appendFileSync(LOG_FILE, line);
	} catch { /* best effort */ }
}

export const log = {
	info: (tag: string, ...args: any[]) => write('INFO', tag, ...args),
	warn: (tag: string, ...args: any[]) => write('WARN', tag, ...args),
	error: (tag: string, ...args: any[]) => write('ERROR', tag, ...args),
	file: LOG_FILE,
};
