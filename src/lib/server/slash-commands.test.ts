import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillMd } from './slash-commands';

// Temp fixture directory — tests that exercise the real scanner still
// hit ~/.claude (see note below) but frontmatter parsing tests use this.
const TEST_DIR = join(tmpdir(), `slash-commands-test-${Date.now()}`);
const SKILLS_DIR = join(TEST_DIR, '.claude', 'skills');

beforeEach(() => {
	mkdirSync(SKILLS_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('slash-commands', () => {

	// --- parseSkillMd (exported, tested directly) ---

	test('SKILL.md with frontmatter is parseable', () => {
		const content = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill.`;

		const result = parseSkillMd(content, 'fallback');
		expect(result.name).toBe('test-skill');
		expect(result.description).toBe('A test skill for unit testing');
	});

	test('SKILL.md with quoted values parses correctly', () => {
		const content = `---
name: "quoted-skill"
description: 'A skill with quoted values'
---

Instructions here.`;

		const result = parseSkillMd(content, 'fallback');
		expect(result.name).toBe('quoted-skill');
		expect(result.description).toBe('A skill with quoted values');
	});

	test('SKILL.md without frontmatter falls back to first paragraph', () => {
		const content = `# My Skill

This is the first paragraph that should be used as the description.

More content here.`;

		const result = parseSkillMd(content, 'my-skill');
		expect(result.name).toBe('my-skill');
		expect(result.description).toBe('This is the first paragraph that should be used as the description.');
	});

	test('SKILL.md with empty description falls back to body', () => {
		const content = `---
name: no-desc
---

Fallback description from body.

More details.`;

		const result = parseSkillMd(content, 'fallback');
		expect(result.name).toBe('no-desc');
		expect(result.description).toBe('Fallback description from body.');
	});

	test('SKILL.md with CRLF line endings parses correctly', () => {
		const content = '---\r\nname: crlf-skill\r\ndescription: Handles Windows line endings\r\n---\r\n\r\n# CRLF Skill\r\n';

		const result = parseSkillMd(content, 'fallback');
		expect(result.name).toBe('crlf-skill');
		expect(result.description).toBe('Handles Windows line endings');
	});

	// --- Integration tests (use real ~/.claude paths) ---
	// Note: These tests rely on the host machine having ~/.claude/skills/ populated.
	// They're kept for integration coverage but won't pass in CI without fixtures.

	test('built-in commands list is non-empty and has expected entries', async () => {
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
