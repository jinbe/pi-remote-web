import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
	parseSkillMd,
	getSlashCommands,
	refreshSlashCommands,
	clearCommandCache,
} from './slash-commands';

// Temp fixture directory used as a fake home for all scanner tests.
const TEST_DIR = join(tmpdir(), `slash-commands-test-${Date.now()}`);
const SKILLS_DIR = join(TEST_DIR, '.claude', 'skills');

beforeEach(() => {
	mkdirSync(SKILLS_DIR, { recursive: true });
	clearCommandCache();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- Helper to create a skill fixture under the fake home ---

function createSkillFixture(
	baseDir: string,
	skillName: string,
	content: string,
): void {
	const skillDir = join(baseDir, skillName);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, 'SKILL.md'), content);
}

// --- Helper to create a plugin skill fixture under the fake home ---

function createPluginSkillFixture(
	homeDir: string,
	scope: string,
	pluginName: string,
	version: string,
	skillName: string,
	content: string,
): void {
	const skillDir = join(
		homeDir,
		'.claude',
		'plugins',
		'cache',
		scope,
		pluginName,
		version,
		'skills',
		skillName,
	);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, 'SKILL.md'), content);
}

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
		expect(result.description).toBe(
			'This is the first paragraph that should be used as the description.',
		);
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
		const content =
			'---\r\nname: crlf-skill\r\ndescription: Handles Windows line endings\r\n---\r\n\r\n# CRLF Skill\r\n';

		const result = parseSkillMd(content, 'fallback');
		expect(result.name).toBe('crlf-skill');
		expect(result.description).toBe('Handles Windows line endings');
	});

	// --- Built-in / bundled command assertions ---

	test('built-in commands list is non-empty and has expected entries', () => {
		const commands = getSlashCommands({ homeDir: TEST_DIR });

		// Should have all built-in + bundled commands even with an empty home
		expect(commands.length).toBeGreaterThan(50);

		const names = commands.map((c) => c.name);
		expect(names).toContain('help');
		expect(names).toContain('compact');
		expect(names).toContain('model');
		expect(names).toContain('clear');
		expect(names).toContain('batch');
		expect(names).toContain('simplify');
	});

	test('commands have required fields', () => {
		const commands = getSlashCommands({ homeDir: TEST_DIR });

		for (const cmd of commands) {
			expect(cmd.name).toBeTruthy();
			expect(typeof cmd.name).toBe('string');
			expect(cmd.description).toBeDefined();
			expect(typeof cmd.description).toBe('string');
			expect([
				'built-in',
				'bundled-skill',
				'user-skill',
				'plugin-skill',
				'project-skill',
			]).toContain(cmd.source);
		}
	});

	test('no duplicate command names', () => {
		const commands = getSlashCommands({ homeDir: TEST_DIR });
		const names = commands.map((c) => c.name);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length);
	});

	// --- User skill discovery (using fixtures) ---

	test('user skills are discovered from fixture home', () => {
		createSkillFixture(
			SKILLS_DIR,
			'fixture-alpha',
			`---
name: fixture-alpha
description: First fixture skill for testing
---

# Alpha

Alpha skill content.`,
		);
		createSkillFixture(
			SKILLS_DIR,
			'fixture-beta',
			`---
name: fixture-beta
description: Second fixture skill for testing
---

# Beta

Beta skill content.`,
		);

		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const userSkills = commands.filter((c) => c.source === 'user-skill');

		expect(userSkills.length).toBe(2);

		const names = userSkills.map((c) => c.name);
		expect(names).toContain('fixture-alpha');
		expect(names).toContain('fixture-beta');

		const alpha = userSkills.find((c) => c.name === 'fixture-alpha');
		expect(alpha?.description).toBe('First fixture skill for testing');
	});

	test('user skill without SKILL.md is ignored', () => {
		// Create a directory without SKILL.md
		const emptySkillDir = join(SKILLS_DIR, 'no-skillmd');
		mkdirSync(emptySkillDir, { recursive: true });

		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const userSkills = commands.filter((c) => c.source === 'user-skill');

		expect(userSkills.length).toBe(0);
	});

	test('empty home directory produces zero user and plugin skills', () => {
		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const userSkills = commands.filter((c) => c.source === 'user-skill');
		const pluginSkills = commands.filter((c) => c.source === 'plugin-skill');

		expect(userSkills.length).toBe(0);
		expect(pluginSkills.length).toBe(0);
	});

	// --- Plugin skill discovery (using fixtures) ---

	test('plugin skills are discovered from fixture home', () => {
		createPluginSkillFixture(
			TEST_DIR,
			'@test-org',
			'test-plugin',
			'1.0.0',
			'plugin-skill-one',
			`---
name: plugin-skill-one
description: A plugin skill from test-org
---

# Plugin Skill One`,
		);

		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const pluginSkills = commands.filter((c) => c.source === 'plugin-skill');

		expect(pluginSkills.length).toBe(1);
		expect(pluginSkills[0].name).toBe('plugin-skill-one');
		expect(pluginSkills[0].pluginName).toBe('@test-org/test-plugin');
	});

	test('plugin skills use latest version', () => {
		// Create older version
		createPluginSkillFixture(
			TEST_DIR,
			'@acme',
			'widgets',
			'1.0.0',
			'old-skill',
			`---
name: old-skill
description: From version 1.0.0
---`,
		);

		// Create newer version with a different skill
		createPluginSkillFixture(
			TEST_DIR,
			'@acme',
			'widgets',
			'2.1.0',
			'new-skill',
			`---
name: new-skill
description: From version 2.1.0
---`,
		);

		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const pluginSkills = commands.filter((c) => c.source === 'plugin-skill');

		// Only the latest version (2.1.0) should be scanned
		const names = pluginSkills.map((c) => c.name);
		expect(names).toContain('new-skill');
		expect(names).not.toContain('old-skill');
	});

	test('plugin skills include plugin name', () => {
		createPluginSkillFixture(
			TEST_DIR,
			'@scope',
			'my-plugin',
			'0.5.0',
			'scoped-skill',
			`---
name: scoped-skill
description: Scoped plugin skill
---`,
		);

		const commands = refreshSlashCommands({ homeDir: TEST_DIR });
		const pluginSkills = commands.filter((c) => c.source === 'plugin-skill');

		for (const cmd of pluginSkills) {
			expect(cmd.pluginName).toBeTruthy();
		}
	});

	// --- Project skill discovery ---

	test('project skills are discovered from projectDir', () => {
		const projectDir = join(TEST_DIR, 'my-project');
		const projectSkillsDir = join(projectDir, '.claude', 'skills');

		createSkillFixture(
			projectSkillsDir,
			'project-helper',
			`---
name: project-helper
description: A project-level skill
---

# Project Helper`,
		);

		const commands = refreshSlashCommands({
			homeDir: TEST_DIR,
			projectDir,
		});
		const projectSkills = commands.filter(
			(c) => c.source === 'project-skill',
		);

		expect(projectSkills.length).toBe(1);
		expect(projectSkills[0].name).toBe('project-helper');
		expect(projectSkills[0].description).toBe('A project-level skill');
	});

	// --- Caching ---

	test('results are cached and returned on subsequent calls', () => {
		createSkillFixture(
			SKILLS_DIR,
			'cached-skill',
			`---
name: cached-skill
description: Should be cached
---`,
		);

		const first = getSlashCommands({ homeDir: TEST_DIR });
		const second = getSlashCommands({ homeDir: TEST_DIR });

		// Same reference means cache hit
		expect(first).toBe(second);
	});

	test('refreshSlashCommands bypasses cache', () => {
		const first = getSlashCommands({ homeDir: TEST_DIR });

		// Add a new skill after initial scan
		createSkillFixture(
			SKILLS_DIR,
			'late-skill',
			`---
name: late-skill
description: Added after first scan
---`,
		);

		const refreshed = refreshSlashCommands({ homeDir: TEST_DIR });
		const lateSkill = refreshed.find((c) => c.name === 'late-skill');
		expect(lateSkill).toBeDefined();
		expect(lateSkill?.source).toBe('user-skill');

		// Should differ from the first cached result
		expect(refreshed.length).toBeGreaterThan(first.length);
	});

	// --- Deduplication ---

	test('project skill overrides user skill with same name', () => {
		const projectDir = join(TEST_DIR, 'dedup-project');
		const projectSkillsDir = join(projectDir, '.claude', 'skills');

		// User skill
		createSkillFixture(
			SKILLS_DIR,
			'shared-name',
			`---
name: shared-name
description: User version
---`,
		);

		// Project skill with same name
		createSkillFixture(
			projectSkillsDir,
			'shared-name',
			`---
name: shared-name
description: Project version wins
---`,
		);

		const commands = refreshSlashCommands({
			homeDir: TEST_DIR,
			projectDir,
		});
		const matched = commands.filter((c) => c.name === 'shared-name');

		expect(matched.length).toBe(1);
		expect(matched[0].source).toBe('project-skill');
		expect(matched[0].description).toBe('Project version wins');
	});
});
