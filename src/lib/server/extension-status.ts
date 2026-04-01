/**
 * Checks whether the job-callback pi extension is installed (symlinked)
 * into ~/.pi/agent/extensions/ and whether its version matches the repo copy.
 */
import { homedir } from 'os';
import { join, resolve } from 'path';
import { readlink, readFile, symlink, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { log } from './logger';

// --- Constants ---

/** Directory where pi auto-discovers global extensions. */
const PI_EXTENSIONS_DIR = join(homedir(), '.pi', 'agent', 'extensions');

/** Filename of the extension in the target directory. */
const EXTENSION_FILENAME = 'job-callback.ts';

/** Full path to the installed (symlinked) extension. */
const INSTALLED_PATH = join(PI_EXTENSIONS_DIR, EXTENSION_FILENAME);

/** Pattern to extract the version constant from the extension source. */
const VERSION_PATTERN = /export\s+const\s+EXTENSION_VERSION\s*=\s*["']([^"']+)["']/;

// --- Types ---

export interface ExtensionStatus {
	/** Whether the extension file exists in ~/.pi/agent/extensions/. */
	installed: boolean;
	/** Whether the installed file is a symlink pointing to the repo copy. */
	isSymlink: boolean;
	/** Version string from the repo (source of truth). */
	repoVersion: string | null;
	/** Version string from the installed copy. */
	installedVersion: string | null;
	/** Whether the installed version matches the repo version. */
	upToDate: boolean;
	/** Path to the repo extension source. */
	repoPath: string;
	/** Path where the extension should be installed. */
	installedPath: string;
}

// --- Helpers ---

/** Resolve the path to the extension in the repo. */
function getRepoExtensionPath(): string {
	// The extension lives at <project-root>/extensions/job-callback.ts
	// Use process.cwd() as the server runs from the project root.
	return resolve(process.cwd(), 'extensions', EXTENSION_FILENAME);
}

/** Extract the EXTENSION_VERSION from a source file's contents. */
function extractVersion(source: string): string | null {
	const match = source.match(VERSION_PATTERN);
	return match?.[1] ?? null;
}

// --- Public API ---

/**
 * Check the installation status of the job-callback extension.
 */
export async function getExtensionStatus(): Promise<ExtensionStatus> {
	const repoPath = getRepoExtensionPath();
	const result: ExtensionStatus = {
		installed: false,
		isSymlink: false,
		repoVersion: null,
		installedVersion: null,
		upToDate: false,
		repoPath,
		installedPath: INSTALLED_PATH,
	};

	// Read the repo version (source of truth)
	try {
		const repoSource = await readFile(repoPath, 'utf-8');
		result.repoVersion = extractVersion(repoSource);
	} catch {
		log.warn('extension-status', `repo extension not found at ${repoPath}`);
		return result;
	}

	// Check if installed
	if (!existsSync(INSTALLED_PATH)) {
		return result;
	}

	result.installed = true;

	// Check if it's a symlink
	try {
		const linkTarget = await readlink(INSTALLED_PATH);
		const resolvedTarget = resolve(PI_EXTENSIONS_DIR, linkTarget);
		result.isSymlink = resolvedTarget === resolve(repoPath);
	} catch {
		// Not a symlink — it's a regular file (manual copy)
		result.isSymlink = false;
	}

	// Read installed version
	try {
		const installedSource = await readFile(INSTALLED_PATH, 'utf-8');
		result.installedVersion = extractVersion(installedSource);
	} catch {
		log.warn('extension-status', `could not read installed extension at ${INSTALLED_PATH}`);
	}

	// Compare versions
	result.upToDate = !!(
		result.repoVersion &&
		result.installedVersion &&
		result.repoVersion === result.installedVersion
	);

	return result;
}

/**
 * Install or update the extension by creating a symlink from
 * ~/.pi/agent/extensions/job-callback.ts → <repo>/extensions/job-callback.ts.
 *
 * If an existing file/symlink exists, it's replaced.
 */
export async function installExtension(): Promise<ExtensionStatus> {
	const repoPath = getRepoExtensionPath();

	// Ensure the repo extension exists
	if (!existsSync(repoPath)) {
		throw new Error(`Repo extension not found at ${repoPath}`);
	}

	// Ensure the target directory exists
	await mkdir(PI_EXTENSIONS_DIR, { recursive: true });

	// Remove existing file/symlink if present
	if (existsSync(INSTALLED_PATH)) {
		await unlink(INSTALLED_PATH);
		log.info('extension-status', `removed existing extension at ${INSTALLED_PATH}`);
	}

	// Create symlink
	await symlink(repoPath, INSTALLED_PATH);
	log.info('extension-status', `symlinked ${INSTALLED_PATH} → ${repoPath}`);

	return getExtensionStatus();
}
