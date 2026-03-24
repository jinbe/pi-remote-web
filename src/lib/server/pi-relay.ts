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

// --- Per-client write queue to handle backpressure ---

interface ClientState {
	socket: Socket<undefined>;
	writeQueue: Uint8Array[];
	writing: boolean;
}

const clients = new Map<Socket<undefined>, ClientState>();
let dead = false;

function drainClient(state: ClientState): void {
	if (!state.writeQueue.length) {
		state.writing = false;
		return;
	}
	state.writing = true;

	while (state.writeQueue.length > 0) {
		const chunk = state.writeQueue[0];
		const written = state.socket.write(chunk);
		if (written === 0) {
			// Buffer full — wait for drain callback
			return;
		}
		if (written < chunk.length) {
			// Partial write — re-queue remainder
			state.writeQueue[0] = chunk.slice(written);
			return;
		}
		// Full chunk written
		state.writeQueue.shift();
	}
	state.writing = false;
}

function writeToClient(state: ClientState, data: Uint8Array): void {
	state.writeQueue.push(data);
	if (!state.writing) {
		drainClient(state);
	}
}

// Read pi stdout and broadcast to all clients
const reader = (proc.stdout as ReadableStream).getReader();
const decoder = new TextDecoder();

async function pumpStdout() {
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		const encoded = new TextEncoder().encode(chunk);
		for (const [, state] of clients) {
			try {
				writeToClient(state, encoded);
			} catch {
				clients.delete(state.socket);
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

// Buffer incoming client data and flush complete JSONL lines to pi's stdin.
// Large payloads (e.g. base64 image data) may arrive fragmented across
// multiple socket data events — we must reassemble complete lines before
// forwarding to pi, otherwise partial JSON reaches the JSONL parser and
// gets discarded silently.
const clientBuffers = new Map<Socket<undefined>, string>();

// Listen for client connections
const server = Bun.listen({
	unix: socketPath,
	socket: {
		data(socket, data) {
			// Forward client data to pi's stdin
			if (dead) return;
			try {
				const prev = clientBuffers.get(socket) ?? '';
				let buffer = prev + new TextDecoder().decode(data);

				// Forward complete lines only — pi's JSONL parser splits on \n
				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newlineIdx + 1); // include \n
					buffer = buffer.slice(newlineIdx + 1);

					const stdin = proc.stdin as import('bun').FileSink;
					stdin.write(line);
					stdin.flush();

					// Log command type and payload size for debugging
					try {
						const parsed = JSON.parse(line);
						const size = line.length;
						if (size > 10_000) {
							relayLog(`forwarded large command: type=${parsed.type} size=${(size / 1024).toFixed(0)}KB`);
						}
					} catch { /* not valid JSON — forward anyway */ }
				}

				clientBuffers.set(socket, buffer);
			} catch (err) {
				relayLog(`stdin write error: ${(err as Error).message}`);
			}
		},
		open(socket) {
			const state: ClientState = { socket, writeQueue: [], writing: false };
			clients.set(socket, state);
			clientBuffers.set(socket, '');
		},
		drain(socket) {
			// Socket ready for more data — continue draining the write queue
			const state = clients.get(socket);
			if (state) drainClient(state);
		},
		close(socket) {
			clients.delete(socket);
			clientBuffers.delete(socket);
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
	for (const [, state] of clients) {
		try {
			state.socket.write(encoded);
			state.socket.end();
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
