/**
 * Slash command discovery for Claude Code sessions.
 *
 * Claude Code has no protocol for autocomplete, so we discover available
 * commands at startup by scanning:
 * 1. Built-in commands (hardcoded from official docs)
 * 2. User skills (~/.claude/skills/)
 * 3. Plugin skills (~/.claude/plugins/cache/…/skills/)
 * 4. Project skills (.claude/skills/ relative to CWD — resolved per-session)
 *
 * For pi sessions, pi handles its own slash command autocomplete natively.
 */
import { homedir } from 'os';
import { join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { log } from './logger';

// --- Types ---

export interface SlashCommand {
	/** The command name without the leading slash. */
	name: string;
	/** Human-readable description. */
	description: string;
	/** Where the command comes from. */
	source: 'built-in' | 'bundled-skill' | 'user-skill' | 'plugin-skill' | 'project-skill';
	/** Plugin name (only for plugin-skill source). */
	pluginName?: string;
}

// --- Built-in commands (from https://code.claude.com/docs/en/commands) ---

const BUILT_IN_COMMANDS: SlashCommand[] = [
	{ name: 'add-dir', description: 'Add a working directory for file access during the current session', source: 'built-in' },
	{ name: 'agents', description: 'Manage agent configurations', source: 'built-in' },
	{ name: 'btw', description: 'Ask a quick side question without adding to the conversation', source: 'built-in' },
	{ name: 'chrome', description: 'Configure Claude in Chrome settings', source: 'built-in' },
	{ name: 'clear', description: 'Clear conversation history and free up context', source: 'built-in' },
	{ name: 'color', description: 'Set the prompt bar colour for the current session', source: 'built-in' },
	{ name: 'compact', description: 'Compact conversation with optional focus instructions', source: 'built-in' },
	{ name: 'config', description: 'Open settings interface (theme, model, output style)', source: 'built-in' },
	{ name: 'context', description: 'Visualise current context usage as a coloured grid', source: 'built-in' },
	{ name: 'copy', description: 'Copy the last assistant response to clipboard', source: 'built-in' },
	{ name: 'cost', description: 'Show token usage statistics', source: 'built-in' },
	{ name: 'desktop', description: 'Continue the current session in the Claude Code Desktop app', source: 'built-in' },
	{ name: 'diff', description: 'Open interactive diff viewer showing uncommitted changes', source: 'built-in' },
	{ name: 'doctor', description: 'Diagnose and verify your Claude Code installation', source: 'built-in' },
	{ name: 'effort', description: 'Set the model effort level (low/medium/high/max/auto)', source: 'built-in' },
	{ name: 'exit', description: 'Exit the CLI', source: 'built-in' },
	{ name: 'export', description: 'Export the current conversation as plain text', source: 'built-in' },
	{ name: 'extra-usage', description: 'Configure extra usage for rate limits', source: 'built-in' },
	{ name: 'fast', description: 'Toggle fast mode on or off', source: 'built-in' },
	{ name: 'feedback', description: 'Submit feedback about Claude Code', source: 'built-in' },
	{ name: 'branch', description: 'Create a branch of the current conversation', source: 'built-in' },
	{ name: 'help', description: 'Show help and available commands', source: 'built-in' },
	{ name: 'hooks', description: 'View hook configurations for tool events', source: 'built-in' },
	{ name: 'ide', description: 'Manage IDE integrations and show status', source: 'built-in' },
	{ name: 'init', description: 'Initialise project with a CLAUDE.md guide', source: 'built-in' },
	{ name: 'insights', description: 'Generate a report analysing your Claude Code sessions', source: 'built-in' },
	{ name: 'install-github-app', description: 'Set up the Claude GitHub Actions app for a repository', source: 'built-in' },
	{ name: 'install-slack-app', description: 'Install the Claude Slack app', source: 'built-in' },
	{ name: 'keybindings', description: 'Open or create your keybindings configuration file', source: 'built-in' },
	{ name: 'login', description: 'Sign in to your Anthropic account', source: 'built-in' },
	{ name: 'logout', description: 'Sign out from your Anthropic account', source: 'built-in' },
	{ name: 'mcp', description: 'Manage MCP server connections and OAuth', source: 'built-in' },
	{ name: 'memory', description: 'Edit CLAUDE.md memory files and auto-memory', source: 'built-in' },
	{ name: 'model', description: 'Select or change the AI model', source: 'built-in' },
	{ name: 'passes', description: 'Share a free week of Claude Code with friends', source: 'built-in' },
	{ name: 'permissions', description: 'Manage allow, ask, and deny rules for tool permissions', source: 'built-in' },
	{ name: 'plan', description: 'Enter plan mode directly from the prompt', source: 'built-in' },
	{ name: 'plugin', description: 'Manage Claude Code plugins', source: 'built-in' },
	{ name: 'powerup', description: 'Discover Claude Code features through interactive lessons', source: 'built-in' },
	{ name: 'privacy-settings', description: 'View and update your privacy settings', source: 'built-in' },
	{ name: 'release-notes', description: 'View the changelog in an interactive version picker', source: 'built-in' },
	{ name: 'reload-plugins', description: 'Reload all active plugins to apply pending changes', source: 'built-in' },
	{ name: 'remote-control', description: 'Make this session available for remote control', source: 'built-in' },
	{ name: 'remote-env', description: 'Configure the default remote environment for web sessions', source: 'built-in' },
	{ name: 'rename', description: 'Rename the current session', source: 'built-in' },
	{ name: 'resume', description: 'Resume a conversation by ID or name', source: 'built-in' },
	{ name: 'rewind', description: 'Rewind the conversation and/or code to a previous point', source: 'built-in' },
	{ name: 'sandbox', description: 'Toggle sandbox mode', source: 'built-in' },
	{ name: 'schedule', description: 'Create, update, list, or run Cloud scheduled tasks', source: 'built-in' },
	{ name: 'security-review', description: 'Analyse pending changes for security vulnerabilities', source: 'built-in' },
	{ name: 'skills', description: 'List available skills', source: 'built-in' },
	{ name: 'stats', description: 'Visualise daily usage, session history, and streaks', source: 'built-in' },
	{ name: 'status', description: 'Show version, model, account, and connectivity info', source: 'built-in' },
	{ name: 'statusline', description: 'Configure Claude Code status line', source: 'built-in' },
	{ name: 'tasks', description: 'List and manage background tasks', source: 'built-in' },
	{ name: 'terminal-setup', description: 'Configure terminal keybindings', source: 'built-in' },
	{ name: 'theme', description: 'Change the colour theme', source: 'built-in' },
	{ name: 'ultraplan', description: 'Draft a plan, review in browser, then execute', source: 'built-in' },
	{ name: 'upgrade', description: 'Open the upgrade page to switch plans', source: 'built-in' },
	{ name: 'usage', description: 'Show plan usage limits and rate limit status', source: 'built-in' },
	{ name: 'voice', description: 'Toggle push-to-talk voice dictation', source: 'built-in' },
];

/** Bundled skills that ship with Claude Code. */
const BUNDLED_SKILLS: SlashCommand[] = [
	{ name: 'batch', description: 'Orchestrate large-scale changes across a codebase in parallel', source: 'bundled-skill' },
	{ name: 'claude-api', description: 'Load Claude API reference material for your project language', source: 'bundled-skill' },
	{ name: 'debug', description: 'Enable debug logging and troubleshoot issues', source: 'bundled-skill' },
	{ name: 'loop', description: 'Run a prompt repeatedly on an interval', source: 'bundled-skill' },
	{ name: 'simplify', description: 'Review changed files for code reuse, quality, and efficiency', source: 'bundled-skill' },
];

// --- SKILL.md parsing ---

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

function parseSkillMd(content: string, fallbackName: string): { name: string; description: string } {
	const fmMatch = content.match(FRONTMATTER_RE);
	let name = fallbackName;
	let description = '';

	if (fmMatch) {
		const fm = fmMatch[1];
		const nameMatch = fm.match(/^name:\s*(.+)$/m);
		const descMatch = fm.match(/^description:\s*(.+)$/m);
		if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
		if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
	}

	// Fallback: first non-heading paragraph of markdown content (after frontmatter)
	if (!description) {
		const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
		const paras = body.split(/\n\s*\n/)
			.map(p => p.replace(/^#+\s+.*\n?/, '').trim())
			.filter(Boolean);
		if (paras[0]) description = paras[0].slice(0, 250);
	}

	return { name, description };
}

// --- Directory scanners ---

function scanSkillsDir(dir: string, source: SlashCommand['source'], pluginName?: string): SlashCommand[] {
	if (!existsSync(dir)) return [];

	const commands: SlashCommand[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillMdPath = join(dir, entry.name, 'SKILL.md');
			if (!existsSync(skillMdPath)) continue;

			try {
				const content = readFileSync(skillMdPath, 'utf-8');
				const { name, description } = parseSkillMd(content, entry.name);
				commands.push({ name, description, source, pluginName });
			} catch {
				// Skip unreadable skill files
			}
		}
	} catch {
		// Skip unreadable directories
	}
	return commands;
}

function scanUserSkills(): SlashCommand[] {
	return scanSkillsDir(join(homedir(), '.claude', 'skills'), 'user-skill');
}

function scanPluginSkills(): SlashCommand[] {
	const commands: SlashCommand[] = [];
	const pluginsCache = join(homedir(), '.claude', 'plugins', 'cache');
	if (!existsSync(pluginsCache)) return commands;

	try {
		// Structure: ~/.claude/plugins/cache/<scope>/<plugin-name>/<version>/skills/
		for (const scope of readdirSync(pluginsCache, { withFileTypes: true })) {
			if (!scope.isDirectory()) continue;
			const scopeDir = join(pluginsCache, scope.name);

			for (const plugin of readdirSync(scopeDir, { withFileTypes: true })) {
				if (!plugin.isDirectory()) continue;
				const pluginDir = join(scopeDir, plugin.name);

				// Get the latest version directory
				const versions = readdirSync(pluginDir, { withFileTypes: true })
					.filter(v => v.isDirectory())
					.map(v => v.name)
					.sort()
					.reverse();

				if (versions.length === 0) continue;
				const latestDir = join(pluginDir, versions[0]);
				const skillsDir = join(latestDir, 'skills');

				const pluginId = `${scope.name}/${plugin.name}`;
				commands.push(...scanSkillsDir(skillsDir, 'plugin-skill', pluginId));
			}
		}
	} catch {
		// Skip unreadable plugin cache
	}
	return commands;
}

function scanProjectSkills(projectDir: string): SlashCommand[] {
	return scanSkillsDir(join(projectDir, '.claude', 'skills'), 'project-skill');
}

// --- Cached results ---

let cachedCommands: SlashCommand[] | null = null;

/**
 * Get all available slash commands for Claude Code sessions.
 * Results are cached after the first call. Call `refreshSlashCommands()` to force a rescan.
 */
export function getSlashCommands(projectDir?: string): SlashCommand[] {
	if (cachedCommands) return cachedCommands;
	return refreshSlashCommands(projectDir);
}

/**
 * Force a rescan of all slash command sources.
 */
export function refreshSlashCommands(projectDir?: string): SlashCommand[] {
	const start = Date.now();
	const commands: SlashCommand[] = [
		...BUILT_IN_COMMANDS,
		...BUNDLED_SKILLS,
		...scanUserSkills(),
		...scanPluginSkills(),
	];

	if (projectDir) {
		commands.push(...scanProjectSkills(projectDir));
	}

	// Deduplicate: later entries (project > plugin > user) win over earlier ones
	const seen = new Map<string, SlashCommand>();
	for (const cmd of commands) {
		seen.set(cmd.name, cmd);
	}
	cachedCommands = Array.from(seen.values());

	log.info('slash-commands', `discovered ${cachedCommands.length} commands in ${Date.now() - start}ms`);
	return cachedCommands;
}
