// Tests for the enforce-skill fan-out installer (companion to
// `skill-installers.ts`). Verifies:
//   1. `findEnforceSkillSource()` resolves to the bundled SKILL.md.
//   2. `installEnforceSkill()` writes the canonical .interlinked/skills/enforce/
//      copy plus per-runner skill files.
//   3. Every runner gets its native full SKILL.md copy.
//   4. Copilot also gets the intentional prompt-file alias.
//   5. Re-running install is idempotent (no duplicate writes, no errors).
//   6. `uninstallEnforceSkill()` removes installed files but leaves
//      unrelated files in the same dirs alone.
// Later sections (each with its own banner) add the full bundled set, the
// `inspectInstalledSkills` doctor view, legacy-target recognition, and the
// failure paths that must degrade rather than throw. Those sections cover the
// arms named in their own comments — they are not a claim of exhaustiveness
// over every branch in `skill-installers.ts`.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "./non-null.js";
import {
	findEnforceSkillSource,
	findSkillSource,
	inspectInstalledSkills,
	installEnforceSkill,
	installSkills,
	listInstallableSkills,
	uninstallEnforceSkill,
	uninstallSkills,
} from "./skill-installers.js";

// Bundled-source overrides. `readSkillSourceFiles` is a COLLABORATOR of the
// system under test (skill-installers.ts), not the SUT itself: the installer's
// "source went missing / source has no SKILL.md" branches are unreachable
// through the real `skills/` tree because `findSkillSource` guarantees the
// SKILL.md exists. Empty by default, so every other test in this file runs
// against the real bundled skills.
const sourceOverrides = vi.hoisted(
	() => new Map<string, Array<{ relPath: string; content: Buffer }> | null>(),
);

vi.mock("./skill-source-files.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./skill-source-files.js")>();
	return {
		...actual,
		readSkillSourceFiles: (name: string) =>
			sourceOverrides.has(name)
				? (sourceOverrides.get(name) ?? null)
				: actual.readSkillSourceFiles(name),
	};
});

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "skill-installers-test-"));
});

afterEach(() => {
	sourceOverrides.clear();
	rmSync(tmpRoot, { recursive: true, force: true });
});

const MANIFEST_REL = join(".interlinked", "skill-install-manifest.json");

/** Corrupt the ownership manifest so `loadSkillInstallManifest` throws. */
function writeUnreadableManifest(root: string): void {
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, MANIFEST_REL), "{ this is not json");
}

/** Replace `relDir` with a symlink pointing at a decoy directory. */
function symlinkDir(root: string, relDir: string, decoyName: string): string {
	const decoy = join(root, decoyName);
	mkdirSync(decoy, { recursive: true });
	const link = join(root, relDir);
	rmSync(link, { recursive: true, force: true });
	mkdirSync(join(link, ".."), { recursive: true });
	symlinkSync(decoy, link, "dir");
	return decoy;
}

/**
 * The `.cursor/rules/<name>.mdc` alias the pre-native-Cursor installer wrote
 * (`genericCursorAlias`). `recognizedCursorAlias` keys off the heading and the
 * canonical-path pointer, which is what this reproduces.
 */
function legacyCursorAlias(name: string): string {
	return `---
description: "Use when the user asks about the interlinked ${name} skill."
---

# ${name} — Cursor rule alias

This rule is a thin alias. The full skill body lives at:

\`.interlinked/skills/${name}/SKILL.md\`

When the task matches the description above, read that file and follow its
instructions exactly.
`;
}

/**
 * The `.cursor/rules/enforce.mdc` alias the pre-native-Cursor installer wrote
 * for the slash-command skill — `ENFORCE_CURSOR_RULE_ALIAS`, reproduced
 * verbatim from `git show fd9d5f6:src/lib/skill-install-templates.ts`. Its
 * heading carries a LEADING SLASH (`# /enforce`), unlike the generated
 * teaching-skill aliases (`# interlinked-setup`), which is why
 * `recognizedCursorAlias` has to accept both shapes.
 */
function legacyEnforceCursorAlias(): string {
	return `---
description: Use this rule when the user asks to distill AGENTS.md, CLAUDE.md, or similar markdown guidance into enforced Interlinked harness rules; asks to use /enforce; or asks to list, remove, disable, enable, modify, add, or reset distilled rules.
---

# /enforce — Cursor rule alias

This rule is a thin alias. The full skill body lives at:

\`.interlinked/skills/enforce/SKILL.md\`

When the task matches the description above, read that file and follow its
instructions exactly. Parse the user's arguments as distill targets or
lifecycle operations. Write live output to
\`.interlinked/distilled-rules.json\` and persistent user modifications to
\`.interlinked/distilled-rules.overrides.json\`.
`;
}

describe("findEnforceSkillSource", () => {
	function extractFrontmatter(content: string): string {
		const match = content.match(/^---\n([\s\S]*?)\n---\n/);
		return match ? nonNull(match[1]) : "";
	}

	function extractDescription(frontmatter: string): string {
		const blockMatch = frontmatter.match(
			/^description\s*:\s*\|\s*\n([\s\S]*?)(?=\n\S|$)/m,
		);
		if (blockMatch) {
			return nonNull(blockMatch[1])
				.split("\n")
				.map((l) => l.replace(/^\s+/, ""))
				.join(" ")
				.trim();
		}
		const quotedMatch = frontmatter.match(
			/^description\s*:\s*"((?:[^"\\]|\\.)*)"/m,
		);
		if (quotedMatch) {
			return nonNull(quotedMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return "";
	}

	it("returns a non-null path", () => {
		expect(findEnforceSkillSource()).not.toBeNull();
	});

	it("returns a path to an existing SKILL.md whose frontmatter names enforce", () => {
		const path = findEnforceSkillSource() as string;
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toContain("name: enforce");
	});

	it("ships a parser-safe source description under 1024 chars", () => {
		const path = findEnforceSkillSource() as string;
		const content = readFileSync(path, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});

	it("rewrites the per-claude SKILL.md description under 1024 chars on install", () => {
		// The repository no longer tracks `.claude/skills/enforce/SKILL.md`
		// (gitignored — `interlinked enable` materializes it from skills/ on
		// install). Verify the contract by installing into a tmpdir and
		// reading the produced file.
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		const content = readFileSync(claudePath, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});
});

describe("installEnforceSkill", () => {
	it("writes the canonical .interlinked/skills/enforce/SKILL.md", () => {
		const results = installEnforceSkill(tmpRoot, ["claude"]);
		const canonical = join(tmpRoot, ".interlinked", "skills", "enforce", "SKILL.md");
		expect(existsSync(canonical)).toBe(true);
		const content = readFileSync(canonical, "utf-8");
		expect(content).toContain("name: enforce");
		expect(results.length).toBeGreaterThan(0);
	});

	it("installs full SKILL.md for spec-compliant runners (claude)", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		expect(existsSync(claudePath)).toBe(true);
		const content = readFileSync(claudePath, "utf-8");
		expect(content).toContain("name: enforce");
		expect(content.length).toBeGreaterThan(2000); // full body, not alias
	});

	it("installs full SKILL.md for codex and gemini", () => {
		installEnforceSkill(tmpRoot, ["codex", "gemini"]);
		expect(existsSync(join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md"))).toBe(
			true,
		);
		expect(
			existsSync(join(tmpRoot, ".gemini", "skills", "enforce", "SKILL.md")),
		).toBe(true);
	});

	it("installs full SKILL.md for Copilot at .github/skills/enforce/SKILL.md", () => {
		installEnforceSkill(tmpRoot, ["copilot"]);
		const skillPath = join(tmpRoot, ".github", "skills", "enforce", "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		const content = readFileSync(skillPath, "utf-8");
		expect(content).toContain("name: enforce");
		expect(content.length).toBeGreaterThan(2000);
	});

	it("installs a Copilot prompt alias alongside the native skill copy", () => {
		installEnforceSkill(tmpRoot, ["copilot"]);
		const aliasPath = join(tmpRoot, ".github", "prompts", "enforce.prompt.md");
		expect(existsSync(aliasPath)).toBe(true);
		const content = readFileSync(aliasPath, "utf-8");
		expect(content).toContain(".interlinked/skills/enforce/SKILL.md");
		expect(content.length).toBeLessThan(2000); // alias, not full body
	});

	it("installs a native Cursor skill at .cursor/skills/enforce/SKILL.md", () => {
		installEnforceSkill(tmpRoot, ["cursor"]);
		const skillPath = join(tmpRoot, ".cursor", "skills", "enforce", "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		const content = readFileSync(skillPath, "utf-8");
		expect(content).toContain("description:");
		expect(content).toContain("name: enforce");
		expect(content.length).toBeGreaterThan(2000);
	});

	it("is idempotent across runs", () => {
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		const firstClaude = readFileSync(
			join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"),
			"utf-8",
		);
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		const secondClaude = readFileSync(
			join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"),
			"utf-8",
		);
		expect(firstClaude).toBe(secondClaude);
	});

	it("returns one result per requested client", () => {
		const results = installEnforceSkill(tmpRoot, ["claude", "codex", "copilot"]);
		expect(results).toHaveLength(3);
		expect(results.map((r) => r.client).sort()).toEqual(
			["claude", "codex", "copilot"].sort(),
		);
		expect(results.every((r) => r.installed)).toBe(true);
	});
});

describe("description transform for runners with strict limits", () => {
	function extractFrontmatter(content: string): string {
		const match = content.match(/^---\n([\s\S]*?)\n---\n/);
		return match ? nonNull(match[1]) : "";
	}

	function extractDescription(frontmatter: string): string {
		// Block scalar: `description: |\n  line1\n  line2`
		const blockMatch = frontmatter.match(
			/^description\s*:\s*\|\s*\n([\s\S]*?)(?=\n\S|$)/m,
		);
		if (blockMatch) {
			return nonNull(blockMatch[1])
				.split("\n")
				.map((l) => l.replace(/^\s+/, ""))
				.join(" ")
				.trim();
		}
		// Double-quoted scalar: `description: "..."`
		const quotedMatch = frontmatter.match(
			/^description\s*:\s*"((?:[^"\\]|\\.)*)"/m,
		);
		if (quotedMatch) {
			return nonNull(quotedMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return "";
	}

	it.each([
		["claude", ".claude/skills/enforce/SKILL.md"],
		["codex", ".agents/skills/enforce/SKILL.md"],
		["gemini", ".gemini/skills/enforce/SKILL.md"],
		["copilot", ".github/skills/enforce/SKILL.md"],
		["cursor", ".cursor/skills/enforce/SKILL.md"],
		["opencode", ".opencode/skills/enforce/SKILL.md"],
		["opencode2", ".opencode/skills/enforce/SKILL.md"],
		["pi", ".pi/skills/enforce/SKILL.md"],
	] as const)("%s install keeps description under 1024 chars", (client, relPath) => {
		installEnforceSkill(tmpRoot, [client]);
		const content = readFileSync(join(tmpRoot, relPath), "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});

	it("codex install description still mentions /enforce invocation", () => {
		installEnforceSkill(tmpRoot, ["codex"]);
		const codexPath = join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md");
		const content = readFileSync(codexPath, "utf-8");
		const description = extractDescription(extractFrontmatter(content));
		expect(description).toContain("/enforce");
		expect(description).toContain("AGENTS.md");
	});

	it("codex install body length matches the source SKILL.md body", () => {
		installEnforceSkill(tmpRoot, ["codex"]);
		const codexPath = join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md");
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		// Need claude install to compare
		installEnforceSkill(tmpRoot, ["claude"]);
		const codexContent = readFileSync(codexPath, "utf-8");
		const claudeContent = readFileSync(claudePath, "utf-8");
		const codexBody = codexContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		const claudeBody = claudeContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		expect(codexBody).toBe(claudeBody);
	});

	it("claude install body still matches the source SKILL.md body", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		const claudePath = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		const sourcePath = findEnforceSkillSource() as string;
		const claudeContent = readFileSync(claudePath, "utf-8");
		const sourceContent = readFileSync(sourcePath, "utf-8");
		const claudeBody = claudeContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		const sourceBody = sourceContent.replace(/^---\n[\s\S]*?\n---\n/, "");
		expect(claudeBody).toBe(sourceBody);
	});
});

describe("uninstallEnforceSkill", () => {
	it("removes installed skill files", () => {
		installEnforceSkill(tmpRoot, ["claude", "copilot"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(
			true,
		);
		expect(
			existsSync(join(tmpRoot, ".github", "skills", "enforce", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md")),
		).toBe(true);

		uninstallEnforceSkill(tmpRoot, ["claude", "copilot"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(
			false,
		);
		expect(
			existsSync(join(tmpRoot, ".github", "skills", "enforce", "SKILL.md")),
		).toBe(false);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md")),
		).toBe(false);
	});

	it("leaves unrelated files in the same directories alone", () => {
		installEnforceSkill(tmpRoot, ["claude"]);
		// Drop a sibling skill the user might have installed.
		const siblingPath = join(tmpRoot, ".claude", "skills", "tdd", "SKILL.md");
		mkdirSync(join(tmpRoot, ".claude", "skills", "tdd"), { recursive: true });
		writeFileSync(siblingPath, "---\nname: tdd\n---\n");

		uninstallEnforceSkill(tmpRoot, ["claude"]);
		expect(existsSync(siblingPath)).toBe(true);
	});

	it("returns false when nothing was installed", () => {
		const result = uninstallEnforceSkill(tmpRoot, ["claude"]);
		expect(result).toBe(false);
	});
});

describe("installSkills (full bundled set)", () => {
	it("installs enforce and the interlinked-* teaching skills for a runner", () => {
		const results = installSkills(tmpRoot, ["claude"]);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(true);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "interlinked", "SKILL.md"))).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".claude", "skills", "interlinked-setup", "SKILL.md")),
		).toBe(true);
		expect(results.some((r) => r.skill === "enforce" && r.installed)).toBe(true);
		expect(results.some((r) => r.skill.startsWith("interlinked") && r.installed)).toBe(true);
	});

	it("gives teaching skills a native Cursor copy but no Copilot prompt alias", () => {
		installSkills(tmpRoot, ["cursor", "copilot"]);
		expect(
			existsSync(join(tmpRoot, ".cursor", "skills", "interlinked-setup", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".github", "prompts", "interlinked-setup.prompt.md")),
		).toBe(false);
		// enforce keeps its Copilot prompt alias.
		expect(existsSync(join(tmpRoot, ".github", "prompts", "enforce.prompt.md"))).toBe(true);
	});

	it("ships teaching-skill descriptions verbatim to spec runners", () => {
		installSkills(tmpRoot, ["claude"]);
		const content = readFileSync(
			join(tmpRoot, ".claude", "skills", "interlinked-setup", "SKILL.md"),
			"utf-8",
		);
		expect(content).toContain("name: interlinked-setup");
	});

	it("copies runner metadata and every bundled resource", () => {
		installSkills(tmpRoot, ["codex"]);
		expect(
			existsSync(join(tmpRoot, ".agents", "skills", "interlinked", "agents", "openai.yaml")),
		).toBe(true);
		expect(
			existsSync(
				join(tmpRoot, ".interlinked", "skills", "interlinked", "agents", "openai.yaml"),
			),
		).toBe(true);
	});
});

describe("uninstallSkills (full bundled set)", () => {
	it("removes every installed skill for the requested clients", () => {
		installSkills(tmpRoot, ["claude", "cursor"]);
		expect(uninstallSkills(tmpRoot, ["claude", "cursor"])).toBe(true);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "interlinked", "SKILL.md"))).toBe(false);
		expect(
			existsSync(join(tmpRoot, ".cursor", "skills", "interlinked-setup", "SKILL.md")),
		).toBe(false);
	});

	it("returns false when nothing was installed", () => {
		expect(uninstallSkills(tmpRoot, ["claude"])).toBe(false);
	});
});

// ===========================================
// Shipped-source frontmatter invariant
// ===========================================
// A runner-facing SKILL.md whose frontmatter is invalid YAML is dropped
// SILENTLY — no error, the skill simply never loads. The `enforce` skill was
// never exposed to this because the installer rewrites its description through
// `quoteYamlDouble`; the interlinked-* teaching skills ship their descriptions
// VERBATIM, so validity is the author's responsibility and nothing checked it.
// Five of the nine shipped with a bare description containing ": " (illegal in
// a YAML plain scalar) and would have failed to load. Hence this gate.

/** The frontmatter block of a SKILL.md, or "" when absent/malformed. */
function frontmatterBlock(content: string): string {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	return match ? nonNull(match[1]) : "";
}

/** The raw `description:` value, verbatim and trimmed. Null when absent. */
function descriptionValue(frontmatter: string): string | null {
	const match = frontmatter.match(/^description:\s*(.*)$/m);
	return match ? nonNull(match[1]).trim() : null;
}

/**
 * True when `value` is a well-formed YAML double-quoted scalar: it opens with
 * `"`, every interior `"` is backslash-escaped, and the scalar terminates on
 * the final character. Quoting is what makes the authored text irrelevant to
 * the parser — a quoted scalar may contain ": ", " #", and other indicators
 * that would break a bare one.
 */
function isQuotedYamlScalar(value: string): boolean {
	if (value.length < 2 || !value.startsWith('"')) return false;
	let i = 1;
	while (i < value.length) {
		if (value[i] === "\\") {
			i += 2;
			continue;
		}
		if (value[i] === '"') return i === value.length - 1;
		i += 1;
	}
	return false;
}

describe("shipped SKILL.md frontmatter is loader-safe", () => {
	const skills = listInstallableSkills();

	// Guards the it.each below: an empty list would produce ZERO test cases and
	// report green — the "silently passed 0/0" failure mode.
	it("discovers the full bundled set", () => {
		expect(skills).toEqual([
			"enforce",
			"interlinked",
			"interlinked-coordination",
			"interlinked-harness",
			"interlinked-observability",
			"interlinked-quality-gates",
			"interlinked-semantic-index",
			"interlinked-setup",
			"interlinked-simplification",
			"interlinked-spec-audit",
			"interlinked-supply-chain",
			"interlinked-verify",
		]);
	});

	it.each(skills)("%s: description is a quoted, length-safe scalar", (name) => {
		const source = findSkillSource(name);
		expect(source, `${name}: source not resolvable`).not.toBeNull();

		const frontmatter = frontmatterBlock(readFileSync(nonNull(source), "utf-8"));
		expect(frontmatter, `${name}: missing or malformed frontmatter block`).not.toBe("");

		const value = descriptionValue(frontmatter);
		expect(value, `${name}: frontmatter has no description key`).not.toBeNull();
		expect(
			isQuotedYamlScalar(nonNull(value)),
			`${name}: description must be double-quoted (inner quotes escaped) — a bare value containing ": " is invalid YAML and the skill will not load`,
		).toBe(true);

		// Several skill loaders reject descriptions over 1024 characters.
		expect(
			nonNull(value).length,
			`${name}: description exceeds the 1024-char loader limit`,
		).toBeLessThanOrEqual(1024);
	});
});

// ===========================================
// inspectInstalledSkills — the `doctor` view
// ===========================================
// Reports how many runner-facing files the bundled set expects, how many are
// byte-identical on disk, and one issue line per drifted / legacy / unreachable
// target. It is the read-only twin of installSkills, so every assertion below
// pins it against a real install rather than a fixture.

describe("inspectInstalledSkills", () => {
	it("reports every expected file as missing on an untouched project", () => {
		const inspection = inspectInstalledSkills(tmpRoot, ["claude"]);

		expect(inspection.expectedFiles).toBeGreaterThan(0);
		expect(inspection.currentFiles).toBe(0);
		expect(inspection.issues).toHaveLength(inspection.expectedFiles);
		expect(inspection.issues).toContain(
			`${join(".claude", "skills", "enforce", "SKILL.md")}: missing or stale`,
		);
		expect(inspection.issues.every((line) => line.endsWith(": missing or stale"))).toBe(true);
	});

	it("reports nothing to fix straight after a clean install", () => {
		installSkills(tmpRoot, ["claude", "copilot"]);

		const inspection = inspectInstalledSkills(tmpRoot, ["claude", "copilot"]);

		expect(inspection.issues).toEqual([]);
		expect(inspection.currentFiles).toBe(inspection.expectedFiles);
		// Copilot expects one extra file (the enforce prompt alias) over Claude.
		expect(inspection.expectedFiles).toBe(
			inspectInstalledSkills(tmpRoot, ["claude"]).expectedFiles * 2 + 1,
		);
	});

	it("counts expectations per requested client and expects nothing for none", () => {
		const one = inspectInstalledSkills(tmpRoot, ["claude"]);
		const two = inspectInstalledSkills(tmpRoot, ["claude", "gemini"]);
		const none = inspectInstalledSkills(tmpRoot, []);

		expect(one.expectedFiles).toBe(listInstallableSkills().length * 2); // SKILL.md + agents/openai.yaml
		expect(two.expectedFiles).toBe(one.expectedFiles * 2);
		expect(none).toEqual({ expectedFiles: 0, currentFiles: 0, issues: [] });
	});

	it.each([
		["an edited file", (path: string) => writeFileSync(path, "tampered\n")],
		["a deleted file", (path: string) => rmSync(path)],
	])("flags %s and leaves the rest current", (_label, damage) => {
		installSkills(tmpRoot, ["claude"]);
		const clean = inspectInstalledSkills(tmpRoot, ["claude"]);
		const relPath = join(".claude", "skills", "interlinked", "SKILL.md");

		damage(join(tmpRoot, relPath));
		const damaged = inspectInstalledSkills(tmpRoot, ["claude"]);

		expect(damaged.expectedFiles).toBe(clean.expectedFiles);
		expect(damaged.currentFiles).toBe(clean.currentFiles - 1);
		expect(damaged.issues).toEqual([`${relPath}: missing or stale`]);
	});

	it("flags a leftover Cursor .mdc rule alias as a legacy install target", () => {
		installSkills(tmpRoot, ["cursor"]);
		const relPath = join(".cursor", "rules", "interlinked-setup.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(join(tmpRoot, relPath), legacyCursorAlias("interlinked-setup"));

		const inspection = inspectInstalledSkills(tmpRoot, ["cursor"]);

		expect(inspection.issues).toEqual([`${relPath}: legacy install target`]);
		expect(inspection.currentFiles).toBe(inspection.expectedFiles);
	});

	// The enforce alias is the ONE `.mdc` the old installer hand-wrote rather
	// than generating, and it used the slash-command heading. It shipped
	// unrecognized: `recognizedCursorAlias("enforce")` looked only for
	// `# enforce — Cursor rule alias`, which is not a substring of
	// `# /enforce — Cursor rule alias`.
	it("flags the leftover hand-written /enforce Cursor alias as a legacy install target", () => {
		installSkills(tmpRoot, ["cursor"]);
		const relPath = join(".cursor", "rules", "enforce.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(join(tmpRoot, relPath), legacyEnforceCursorAlias());

		const inspection = inspectInstalledSkills(tmpRoot, ["cursor"]);

		expect(inspection.issues).toEqual([`${relPath}: legacy install target`]);
		expect(inspection.currentFiles).toBe(inspection.expectedFiles);
	});

	// Both conjuncts of the alias predicate must still discriminate: a
	// name-free heading match or a pointer-free heading match would make the
	// slash-form fix over-broad.
	it.each([
		[
			"the heading names a different skill",
			// Pointer left intact, so only the heading check can reject it.
			legacyEnforceCursorAlias().replace(
				"# /enforce — Cursor rule alias",
				"# /interlinked — Cursor rule alias",
			),
		],
		[
			"the slash heading points at a different canonical file",
			// Heading left intact, so only the pointer check can reject it.
			legacyEnforceCursorAlias().replace(
				".interlinked/skills/enforce/SKILL.md",
				".interlinked/skills/interlinked/SKILL.md",
			),
		],
	])("does not flag an enforce.mdc when %s", (_label, body) => {
		installSkills(tmpRoot, ["cursor"]);
		const relPath = join(".cursor", "rules", "enforce.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(join(tmpRoot, relPath), body);

		expect(inspectInstalledSkills(tmpRoot, ["cursor"]).issues).toEqual([]);
	});

	it("does not flag a user-authored .mdc rule that happens to share the name", () => {
		installSkills(tmpRoot, ["cursor"]);
		const relPath = join(".cursor", "rules", "interlinked-setup.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(
			join(tmpRoot, relPath),
			"---\ndescription: mine\n---\n\n# my own interlinked-setup notes\n",
		);

		expect(inspectInstalledSkills(tmpRoot, ["cursor"]).issues).toEqual([]);
	});

	it.each([
		["codex", join(".agents", "skills"), join(".codex", "skills")],
		["gemini", join(".gemini", "skills"), join(".gemini", "extensions")],
	] as const)(
		"flags the pre-native %s SKILL.md location as a legacy install target",
		(client, currentRoot, legacyRoot) => {
			installSkills(tmpRoot, [client]);
			const legacyRel = join(legacyRoot, "enforce", "SKILL.md");
			mkdirSync(join(tmpRoot, legacyRoot, "enforce"), { recursive: true });
			writeFileSync(
				join(tmpRoot, legacyRel),
				readFileSync(join(tmpRoot, currentRoot, "enforce", "SKILL.md")),
			);

			const inspection = inspectInstalledSkills(tmpRoot, [client]);

			expect(inspection.issues).toEqual([`${legacyRel}: legacy install target`]);
		},
	);

	it("does not flag a legacy-path file belonging to a different skill", () => {
		installSkills(tmpRoot, ["codex"]);
		const legacyRel = join(".codex", "skills", "enforce", "SKILL.md");
		mkdirSync(join(tmpRoot, ".codex", "skills", "enforce"), { recursive: true });
		writeFileSync(join(tmpRoot, legacyRel), "---\nname: someone-elses-skill\n---\n\nbody\n");

		expect(inspectInstalledSkills(tmpRoot, ["codex"]).issues).toEqual([]);
	});

	it("reports a symlinked skills root as an issue per file instead of throwing", () => {
		symlinkDir(tmpRoot, join(".claude", "skills"), "decoy-claude");

		const inspection = inspectInstalledSkills(tmpRoot, ["claude"]);

		expect(inspection.currentFiles).toBe(0);
		// Pin the count outright: `issues.every(...)` below is vacuously true on
		// an empty array, so the length must be independently non-zero.
		expect(inspection.expectedFiles).toBe(listInstallableSkills().length * 2);
		expect(inspection.issues).toHaveLength(inspection.expectedFiles);
		expect(
			inspection.issues.every((line) =>
				line.includes("Refusing skill path through symlinked directory"),
			),
		).toBe(true);
	});

	it("reports a symlinked legacy-target directory as an issue without losing the clean count", () => {
		installSkills(tmpRoot, ["cursor"]);
		symlinkDir(tmpRoot, join(".cursor", "rules"), "decoy-cursor-rules");

		const inspection = inspectInstalledSkills(tmpRoot, ["cursor"]);

		expect(inspection.currentFiles).toBe(inspection.expectedFiles);
		// One unreachable legacy `.mdc` probe per bundled skill — asserted
		// non-zero so the `every(...)` below cannot pass vacuously.
		expect(inspection.issues.length).toBeGreaterThan(0);
		expect(inspection.issues).toHaveLength(listInstallableSkills().length);
		expect(
			inspection.issues.every((line) =>
				line.includes("Refusing skill path through symlinked directory"),
			),
		).toBe(true);
	});
});

// ===========================================
// Failure paths that must degrade, not throw
// ===========================================

describe("install failure reporting", () => {
	it("fails every skill/client pair when the ownership manifest is unreadable", () => {
		writeUnreadableManifest(tmpRoot);

		const results = installSkills(tmpRoot, ["claude", "codex"]);

		expect(results).toHaveLength(listInstallableSkills().length * 2);
		expect(results.every((r) => r.installed === false)).toBe(true);
		expect(results.every((r) => r.path === "")).toBe(true);
		expect(nonNull(results[0]).error).toContain(
			"Cannot read .interlinked/skill-install-manifest.json",
		);
		// Nothing was written on the way to the failure.
		expect(existsSync(join(tmpRoot, ".claude"))).toBe(false);
		expect(existsSync(join(tmpRoot, ".agents"))).toBe(false);
	});

	it("fails the enforce install when the ownership manifest is unreadable", () => {
		writeUnreadableManifest(tmpRoot);

		const results = installEnforceSkill(tmpRoot, ["claude"]);

		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).skill).toBe("enforce");
		expect(nonNull(results[0]).installed).toBe(false);
		expect(nonNull(results[0]).error).toContain("Cannot read");
		expect(existsSync(join(tmpRoot, ".claude"))).toBe(false);
	});

	it.each([
		["uninstallSkills", uninstallSkills],
		["uninstallEnforceSkill", uninstallEnforceSkill],
	] as const)("%s reports no change when the manifest is unreadable", (_label, uninstall) => {
		writeUnreadableManifest(tmpRoot);

		expect(uninstall(tmpRoot, ["claude"])).toBe(false);
		// The unreadable manifest is left untouched for the human to inspect.
		expect(readFileSync(join(tmpRoot, MANIFEST_REL), "utf-8")).toBe("{ this is not json");
	});

	// The canonical `.interlinked/skills/<name>/SKILL.md` copy is the one
	// CLAUDE.md points humans and agents at, so hand-editing it is the most
	// likely real-world degradation. It must fail exactly that skill.
	it("fails every client of a hand-edited skill and still installs the rest", () => {
		installSkills(tmpRoot, ["claude", "codex"]);
		const canonicalRel = join(".interlinked", "skills", "enforce", "SKILL.md");
		const handEdited = "---\nname: enforce\n---\n\nhand-edited\n";
		writeFileSync(join(tmpRoot, canonicalRel), handEdited);
		const claudeEnforce = join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md");
		const installedEnforce = readFileSync(claudeEnforce, "utf-8");
		// Delete an unrelated skill's runner copy: only a loop that keeps going
		// past the enforce failure can put it back.
		const otherRel = join(".claude", "skills", "interlinked", "SKILL.md");
		rmSync(join(tmpRoot, otherRel));

		const results = installSkills(tmpRoot, ["claude", "codex"]);

		const refusal = `Refusing to overwrite modified managed skill file: ${canonicalRel}`;
		expect(results.filter((r) => r.skill === "enforce")).toEqual([
			{ skill: "enforce", client: "claude", path: "", installed: false, error: refusal },
			{ skill: "enforce", client: "codex", path: "", installed: false, error: refusal },
		]);
		const others = results.filter((r) => r.skill !== "enforce");
		expect(others).toHaveLength((listInstallableSkills().length - 1) * 2);
		expect(others.every((r) => r.installed)).toBe(true);
		expect(existsSync(join(tmpRoot, otherRel))).toBe(true);
		// The refusal is a no-op: the human's edit and the already-installed
		// runner copies survive byte-identical.
		expect(readFileSync(join(tmpRoot, canonicalRel), "utf-8")).toBe(handEdited);
		expect(readFileSync(claudeEnforce, "utf-8")).toBe(installedEnforce);
	});

	it("refuses to write through a symlinked runner skills root", () => {
		installSkills(tmpRoot, ["claude"]);
		const decoy = symlinkDir(tmpRoot, join(".claude", "skills"), "decoy-claude");

		const results = installSkills(tmpRoot, ["claude"]);

		// One result per bundled skill — pinned so the `every(...)` assertions
		// below cannot pass vacuously on an empty array.
		expect(results).toHaveLength(listInstallableSkills().length);
		expect(results.map((r) => r.skill).sort()).toEqual([...listInstallableSkills()].sort());
		expect(results.every((r) => r.installed === false)).toBe(true);
		expect(
			results.every((r) =>
				nonNull(r.error).includes("Refusing skill path through symlinked directory"),
			),
		).toBe(true);
		expect(existsSync(join(decoy, "enforce"))).toBe(false);
		// Stronger than the line above: nothing at all leaked through the link.
		expect(readdirSync(decoy)).toEqual([]);
	});

	it("still installs but reports a legacy-cleanup failure when the legacy dir is symlinked", () => {
		symlinkDir(tmpRoot, join(".cursor", "rules"), "decoy-cursor-rules");

		const results = installEnforceSkill(tmpRoot, ["cursor"]);

		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).installed).toBe(true);
		expect(nonNull(results[0]).error).toMatch(/^Installed, but legacy target cleanup failed: /);
		expect(nonNull(results[0]).error).toContain("symlinked directory");
		expect(existsSync(join(tmpRoot, ".cursor", "skills", "enforce", "SKILL.md"))).toBe(true);
	});
});

// ===========================================
// Legacy-target cleanup on uninstall
// ===========================================

describe("uninstall removes recognized legacy targets", () => {
	it("deletes a leftover Cursor .mdc alias alongside the managed copies", () => {
		installSkills(tmpRoot, ["cursor"]);
		const legacy = join(tmpRoot, ".cursor", "rules", "interlinked-setup.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(legacy, legacyCursorAlias("interlinked-setup"));

		expect(uninstallSkills(tmpRoot, ["cursor"])).toBe(true);

		expect(existsSync(legacy)).toBe(false);
		expect(
			existsSync(join(tmpRoot, ".cursor", "skills", "interlinked-setup", "SKILL.md")),
		).toBe(false);
	});

	it("deletes the hand-written /enforce Cursor alias when uninstalling enforce", () => {
		installEnforceSkill(tmpRoot, ["cursor"]);
		const legacy = join(tmpRoot, ".cursor", "rules", "enforce.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(legacy, legacyEnforceCursorAlias());

		expect(uninstallEnforceSkill(tmpRoot, ["cursor"])).toBe(true);

		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(join(tmpRoot, ".cursor", "skills", "enforce", "SKILL.md"))).toBe(false);
	});

	it("keeps an enforce.mdc whose slash heading points at another skill", () => {
		installEnforceSkill(tmpRoot, ["cursor"]);
		const mine = join(tmpRoot, ".cursor", "rules", "enforce.mdc");
		const body = legacyEnforceCursorAlias().replace(
			".interlinked/skills/enforce/SKILL.md",
			".interlinked/skills/interlinked/SKILL.md",
		);
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(mine, body);

		uninstallEnforceSkill(tmpRoot, ["cursor"]);

		expect(readFileSync(mine, "utf-8")).toBe(body);
	});

	it("keeps a user-authored .mdc rule that shares a skill name", () => {
		installSkills(tmpRoot, ["cursor"]);
		const mine = join(tmpRoot, ".cursor", "rules", "interlinked-setup.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(mine, "---\ndescription: mine\n---\n\n# hand-written\n");

		uninstallSkills(tmpRoot, ["cursor"]);

		expect(readFileSync(mine, "utf-8")).toContain("# hand-written");
	});

	it("deletes the pre-native Codex SKILL.md copy when uninstalling enforce", () => {
		installEnforceSkill(tmpRoot, ["codex"]);
		const legacy = join(tmpRoot, ".codex", "skills", "enforce", "SKILL.md");
		mkdirSync(join(tmpRoot, ".codex", "skills", "enforce"), { recursive: true });
		writeFileSync(
			legacy,
			readFileSync(join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md")),
		);

		expect(uninstallEnforceSkill(tmpRoot, ["codex"])).toBe(true);

		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(join(tmpRoot, ".agents", "skills", "enforce", "SKILL.md"))).toBe(false);
	});
});

// ===========================================
// Bundled source that does not resolve
// ===========================================
// These use the `sourceOverrides` collaborator hook declared at the top of the
// file. The installer's own code runs unmocked.

describe("unresolvable bundled skill source", () => {
	it("fails only the source-less skill and installs the rest", () => {
		sourceOverrides.set("interlinked-verify", null);

		const results = installSkills(tmpRoot, ["claude"]);
		const missing = results.filter((r) => r.skill === "interlinked-verify");

		expect(missing).toHaveLength(1);
		expect(nonNull(missing[0])).toMatchObject({
			client: "claude",
			installed: false,
			path: "",
			error: "Skill source not found: interlinked-verify",
		});
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".claude", "skills", "interlinked-verify", "SKILL.md")),
		).toBe(false);
	});

	// `installEnforceSkill` wraps `installOneSkill` in a try/catch, so it
	// degraded here from the start; `installSkills` has no such wrapper, so
	// the same source shape used to throw out of the whole fan-out and take
	// the nine healthy skills with it.
	it("fails only the SKILL.md-less skill instead of throwing out of installSkills", () => {
		sourceOverrides.set("interlinked-verify", [
			{ relPath: "agents/openai.yaml", content: Buffer.from("name: interlinked-verify\n") },
		]);

		const results = installSkills(tmpRoot, ["claude"]);

		expect(results).toHaveLength(listInstallableSkills().length);
		expect(results.filter((r) => r.skill === "interlinked-verify")).toEqual([
			{
				skill: "interlinked-verify",
				client: "claude",
				path: "",
				installed: false,
				error: "Bundled skill has no SKILL.md entry",
			},
		]);
		expect(results.filter((r) => r.skill !== "interlinked-verify").every((r) => r.installed)).toBe(
			true,
		);
		expect(existsSync(join(tmpRoot, ".claude", "skills", "enforce", "SKILL.md"))).toBe(true);
		expect(
			existsSync(join(tmpRoot, ".claude", "skills", "interlinked-verify", "SKILL.md")),
		).toBe(false);
		// The half-written skill leaves no canonical residue either.
		expect(
			existsSync(join(tmpRoot, ".interlinked", "skills", "interlinked-verify")),
		).toBe(false);
	});

	it("fails the enforce install when the bundled source carries no SKILL.md", () => {
		sourceOverrides.set("enforce", [
			{ relPath: "agents/openai.yaml", content: Buffer.from("name: enforce\n") },
		]);

		const results = installEnforceSkill(tmpRoot, ["claude", "codex"]);

		expect(results).toEqual([
			{
				skill: "enforce",
				client: "claude",
				path: "",
				installed: false,
				error: "Bundled skill has no SKILL.md entry",
			},
			{
				skill: "enforce",
				client: "codex",
				path: "",
				installed: false,
				error: "Bundled skill has no SKILL.md entry",
			},
		]);
		expect(existsSync(join(tmpRoot, ".claude"))).toBe(false);
	});

	it("skips a source-less skill when inspecting rather than counting it missing", () => {
		installSkills(tmpRoot, ["claude"]);
		const full = inspectInstalledSkills(tmpRoot, ["claude"]);

		sourceOverrides.set("interlinked-verify", null);
		const partial = inspectInstalledSkills(tmpRoot, ["claude"]);

		expect(partial.expectedFiles).toBe(full.expectedFiles - 2); // SKILL.md + agents/openai.yaml
		expect(partial.issues).toEqual([]);
	});

	it("still removes manifest-owned copies of a source-less skill, but not its legacy alias", () => {
		installSkills(tmpRoot, ["cursor"]);
		const legacy = join(tmpRoot, ".cursor", "rules", "interlinked-verify.mdc");
		mkdirSync(join(tmpRoot, ".cursor", "rules"), { recursive: true });
		writeFileSync(legacy, legacyCursorAlias("interlinked-verify"));

		sourceOverrides.set("interlinked-verify", null);
		expect(uninstallSkills(tmpRoot, ["cursor"])).toBe(true);

		expect(
			existsSync(join(tmpRoot, ".cursor", "skills", "interlinked-verify", "SKILL.md")),
		).toBe(false);
		// No source => no derivable legacy target => the stale alias survives.
		expect(existsSync(legacy)).toBe(true);
	});
});
