// Manages dev server processes per project (cwd)

interface DevServerProcess {
	cwd: string;
	command: string;
	process: ReturnType<typeof Bun.spawn>;
	output: string[];
	startedAt: Date;
}

const activeDevServers = new Map<string, DevServerProcess>();

export function startDevServer(cwd: string, command: string): void {
	if (activeDevServers.has(cwd)) {
		throw new Error(`Dev server already running for ${cwd}`);
	}

	const [cmd, ...args] = command.split(/\s+/);
	const proc = Bun.spawn([cmd, ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, FORCE_COLOR: '0' }
	});

	const managed: DevServerProcess = {
		cwd,
		command,
		process: proc,
		output: [],
		startedAt: new Date()
	};

	activeDevServers.set(cwd, managed);

	// Read stdout
	const readStream = (stream: ReadableStream | null) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		(async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				const lines = text.split('\n');
				for (const line of lines) {
					if (line.trim()) {
						managed.output.push(line);
						// Keep last 200 lines
						if (managed.output.length > 200) managed.output.shift();
					}
				}
			}
		})();
	};

	readStream(proc.stdout as ReadableStream | null);
	readStream(proc.stderr as ReadableStream | null);

	// Clean up on exit
	proc.exited.then(() => {
		activeDevServers.delete(cwd);
	});
}

export async function stopDevServer(cwd: string): Promise<void> {
	const managed = activeDevServers.get(cwd);
	if (!managed) return;
	managed.process.kill();
	await managed.process.exited;
}

export async function stopAllDevServers(): Promise<number> {
	const cwds = [...activeDevServers.keys()];
	await Promise.allSettled(cwds.map(cwd => stopDevServer(cwd)));
	return cwds.length;
}

export function isDevServerRunning(cwd: string): boolean {
	return activeDevServers.has(cwd);
}

export function getRunningDevServerCwds(): string[] {
	return [...activeDevServers.keys()];
}

export function getDevServerOutput(cwd: string): string[] {
	return activeDevServers.get(cwd)?.output ?? [];
}
