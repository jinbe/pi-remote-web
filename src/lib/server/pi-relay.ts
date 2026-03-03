#!/usr/bin/env bun
/**
 * Pi RPC Relay Daemon
 *
 * Runs as an independent process that:
 * 1. Spawns `pi --mode rpc` as a child
 * 2. Listens on a Unix domain socket
 * 3. Relays JSON lines between socket clients and pi's stdin/stdout
 *
 * Multiple clients can connect (e.g. after web server restart).
 * All clients receive all stdout events. Commands from any client go to pi's stdin.
 *
 * Usage: bun pi-relay.ts <socket-path> <cwd> [pi-args...]
 *   e.g. bun pi-relay.ts /tmp/pi-session-abc.sock /home/user/project --session /path/to/session.jsonl
 *   e.g. bun pi-relay.ts /tmp/pi-session-abc.sock /home/user/project --model anthropic/claude-sonnet
 */

import { unlinkSync, writeFileSync } from 'fs';
import type { Socket } from 'bun';

const [socketPath, cwd, ...piArgs] = process.argv.slice(2);

if (!socketPath || !cwd) {
	console.error('Usage: bun pi-relay.ts <socket-path> <cwd> [pi-args...]');
	process.exit(1);
}

const pidPath = socketPath.replace(/\.sock$/, '.pid');

// Clean up stale socket
try { unlinkSync(socketPath); } catch {}

// Spawn pi
const piBin = process.env.PI_BIN || 'pi';
const proc = Bun.spawn([piBin, '--mode', 'rpc', ...piArgs], {
	cwd,
	stdin: 'pipe',
	stdout: 'pipe',
	stderr: 'pipe',
});

// Track connected clients
const clients = new Set<Socket<undefined>>();
let dead = false;

// Read pi stdout and broadcast to all clients
const reader = (proc.stdout as ReadableStream).getReader();
const decoder = new TextDecoder();

async function pumpStdout() {
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		const encoded = new TextEncoder().encode(chunk);
		for (const client of [...clients]) {
			try {
				client.write(encoded);
			} catch {
				clients.delete(client);
			}
		}
	}
}
pumpStdout().catch(() => {});

// Consume stderr and log to file
import { appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const LOG_FILE = join(tmpdir(), 'pi-remote-web', 'debug.log');
function relayLog(msg: string) {
	try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [INFO] [relay-daemon] ${msg}\n`); } catch {}
}

if (proc.stderr) {
	const stderrReader = (proc.stderr as ReadableStream).getReader();
	const stderrDecoder = new TextDecoder();
	(async () => {
		while (true) {
			const { done, value } = await stderrReader.read();
			if (done) break;
			const text = stderrDecoder.decode(value, { stream: true });
			if (text.trim()) {
				relayLog(`[pi stderr] ${text.trim().slice(0, 2000)}`);
				process.stderr.write(`[pi stderr] ${text.slice(0, 4000)}\n`);
			}
		}
	})().catch(() => {});
}

// Listen for client connections
const server = Bun.listen({
	unix: socketPath,
	socket: {
		data(_socket, data) {
			// Forward client data to pi's stdin
			if (dead) return;
			try {
				const stdin = proc.stdin as import('bun').FileSink;
				stdin.write(data);
			} catch {
				// pi process died
			}
		},
		open(socket) {
			clients.add(socket);
		},
		close(socket) {
			clients.delete(socket);
		},
		error(_socket, err) {
			console.error('Socket error:', err.message);
		},
	},
});

// Write PID file AFTER socket is listening — signals readiness to parent
writeFileSync(pidPath, String(process.pid));

// When pi exits, notify clients and shut down
proc.exited.then((code) => {
	const signalCode = proc.signalCode;
	relayLog(`pi exited: code=${code} signal=${signalCode} pid=${proc.pid} clients=${clients.size}`);
	dead = true;
	const msg = JSON.stringify({ type: 'session_ended', exitCode: code, signal: signalCode }) + '\n';
	const encoded = new TextEncoder().encode(msg);
	for (const client of [...clients]) {
		try {
			client.write(encoded);
			client.end();
		} catch {}
	}
	server.stop();
	try { unlinkSync(socketPath); } catch {}
	try { unlinkSync(pidPath); } catch {}
	process.exit(code ?? 0);
});

// Handle signals — forward to pi and exit
function handleSignal(signal: string) {
	relayLog(`received signal: ${signal} — killing pi (pid=${proc.pid})`);
	if (signal === 'SIGUSR1') {
		// Graceful: kill pi, clean up
		proc.kill();
	} else {
		// SIGTERM/SIGINT: kill pi and exit
		proc.kill();
	}
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGUSR1', () => handleSignal('SIGUSR1'));

// Signal readiness to parent, then close stdout (we communicate via socket from here)
process.stdout.write(JSON.stringify({ type: 'relay_ready', pid: process.pid, socketPath }) + '\n');
try { process.stdout.end(); } catch {}
