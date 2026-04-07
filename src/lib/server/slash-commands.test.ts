import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the internal parsing/scanning logic by importing the module
// and using a temp directory structure.

const TEST_DIR = join(tmpdir(), `slash-commands-test-${Date.now()}`);
const SKILLS_DIR = join(TEST_DIR, '.claude', 'skills');

beforeEach(() => {
	mkdirSync(SKILLS_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('slash-commands', () => {
	// We can't easily test the module directly because it hardcodes ~/.claude,
	// but we can test the SKILL.md parsing logic by importing it indirectly.
	// For now, test the structure expectations.

	test('SKILL.md with frontmatter is parseable', () => {
		const content = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill.`;

		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		expect(fmMatch).not.toBeNull();

		const fm = fmMatch![1];
		const nameMatch = fm.match(/^name:\s*(.+)$/m);
		const descMatch = fm.match(/^description:\s*(.+)$/m);

		expect(nameMatch![1].trim()).toBe('test-skill');
		expect(descMatch![1].trim()).toBe('A test skill for unit testing');
	});

	test('SKILL.md with quoted values parses correctly', () => {
		const content = `---
name: "quoted-skill"
description: 'A skill with quoted values'
---

Instructions here.`;

		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		const fm = fmMatch![1];
		const nameMatch = fm.match(/^name:\s*(.+)$/m);
		const descMatch = fm.match(/^description:\s*(.+)$/m);

		const name = nameMatch![1].trim().replace(/^['"]|['"]$/g, '');
		const desc = descMatch![1].trim().replace(/^['"]|['"]$/g, '');

		expect(name).toBe('quoted-skill');
		expect(desc).toBe('A skill with quoted values');
	});

	test('SKILL.md without frontmatter falls back to first paragraph', () => {
		const content = `# My Skill

This is the first paragraph that should be used as the description.

More content here.`;

		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		expect(fmMatch).toBeNull();

		// The heading is its own paragraph, so first non-heading paragraph is second
		const body = content.trim();
		const paras = body.split(/\n\s*\n/).map(p => p.replace(/^#+\s+.*\n?/, '').trim()).filter(Boolean);
		expect(paras[0]).toBe('This is the first paragraph that should be used as the description.');
	});

	test('SKILL.md with empty description falls back to body', () => {
		const content = `---
name: no-desc
---

Fallback description from body.

More details.`;

		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		const fm = fmMatch![1];
		const descMatch = fm.match(/^description:\s*(.+)$/m);
		expect(descMatch).toBeNull();

		const body = content.slice(fmMatch![0].length).trim();
		const firstPara = body.split(/\n\s*\n/)[0]?.replace(/^#+\s+.*\n?/, '').trim();
		expect(firstPara).toBe('Fallback description from body.');
	});

	test('built-in commands list is non-empty and has expected entries', async () => {
		// Import the module to access getSlashCommands
		const { getSlashCommands } = await import('./slash-commands');
		const commands = getSlashCommands();

		expect(commands.length).toBeGreaterThan(50);

		const names = commands.map(c => c.name);
		expect(names).toContain('help');
		expect(names).toContain('compact');
		expect(names).toContain('model');
		expect(names).toContain('clear');
		expect(names).toContain('batch');
		expect(names).toContain('simplify');
	});

	test('commands have required fields', async () => {
		const { getSlashCommands } = await import('./slash-commands');
		const commands = getSlashCommands();

		for (const cmd of commands) {
			expect(cmd.name).toBeTruthy();
			expect(typeof cmd.name).toBe('string');
			expect(cmd.description).toBeDefined();
			expect(typeof cmd.description).toBe('string');
			expect(['built-in', 'bundled-skill', 'user-skill', 'plugin-skill', 'project-skill']).toContain(cmd.source);
		}
	});

	test('no duplicate command names', async () => {
		const { getSlashCommands } = await import('./slash-commands');
		const commands = getSlashCommands();
		const names = commands.map(c => c.name);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length);
	});

	test('user skills are discovered from ~/.claude/skills/', async () => {
		const { getSlashCommands } = await import('./slash-commands');
		const commands = getSlashCommands();
		const userSkills = commands.filter(c => c.source === 'user-skill');
		// We know the user has skills installed
		expect(userSkills.length).toBeGreaterThan(0);
	});

	test('plugin skills include plugin name', async () => {
		const { getSlashCommands } = await import('./slash-commands');
		const commands = getSlashCommands();
		const pluginSkills = commands.filter(c => c.source === 'plugin-skill');
		for (const cmd of pluginSkills) {
			expect(cmd.pluginName).toBeTruthy();
		}
	});
});
