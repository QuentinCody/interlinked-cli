// ===========================================
// Skill install templates — per-runner content rendering (pure)
// ===========================================
// The "what content goes into each runner's file" half of the skill installer.
// No filesystem here — `skill-installers.ts` owns I/O; this module owns the
// Copilot alias template and the per-runner target layout. Every SKILL.md
// ships verbatim: the old `enforce` description swap existed for a 1,024-char
// loader limit that the authored description no longer exceeds, and the
// pinned budget test (`src/lib/__tests__/skills-budget.test.ts`) now keeps
// every authored description far below it.

import { join } from "node:path";
import type { ClientName } from "./settings.js";

/** How a single runner target should be rendered. */
export interface RunnerSkillTarget {
	kind: "spec" | "copilot-prompt-alias";
	/** Path relative to cwd. */
	relPath: string;
}

/** How a skill's content is adapted per runner. */
export interface SkillRenderConfig {
	/** Copilot `.prompt.md` alias body (slash-command runners only). */
	copilotPromptAlias?: string;
}

/** Thin prompt-file alias for Copilot surfaces that still read .prompt.md files. */
const ENFORCE_COPILOT_PROMPT_ALIAS = `---
name: enforce
description: Distill imperative .md guidance into harness-enforced rules with full source provenance. Aliases to the full skill body. Invoke as /enforce with a path, directory, GitHub shorthand (owner/repo/path), or URL. With no argument, walks the project. Lifecycle ops: /enforce list, /enforce remove, /enforce disable, /enforce modify.
---

# /enforce — alias

This is a thin alias. The full skill body lives at:

\`.interlinked/skills/enforce/SKILL.md\`

Read that file and follow its instructions exactly. Parse the user's
argument(s) as distill targets. Output goes to
\`.interlinked/distilled-rules.json\`. Lifecycle ops (list, remove, disable,
enable, modify, add, reset) are documented in the same skill body.
`;

/**
 * The per-skill render config. `enforce` gets its hand-written Copilot alias;
 * every other skill needs no compatibility alias.
 */
export function buildSkillConfig(name: string): SkillRenderConfig {
	return name === "enforce" ? { copilotPromptAlias: ENFORCE_COPILOT_PROMPT_ALIAS } : {};
}

/** Where a given runner expects a skill named `name` to live. */
export function runnerTargets(
	client: ClientName,
	name: string,
	config: SkillRenderConfig,
): RunnerSkillTarget[] {
	switch (client) {
		case "claude":
			return [{ kind: "spec", relPath: join(".claude", "skills", name, "SKILL.md") }];
		case "codex":
			return [{ kind: "spec", relPath: join(".agents", "skills", name, "SKILL.md") }];
		case "gemini":
			return [{ kind: "spec", relPath: join(".gemini", "skills", name, "SKILL.md") }];
		case "copilot": {
			const targets: RunnerSkillTarget[] = [
				{ kind: "spec", relPath: join(".github", "skills", name, "SKILL.md") },
			];
			if (config.copilotPromptAlias) {
				targets.push({
					kind: "copilot-prompt-alias",
					relPath: join(".github", "prompts", `${name}.prompt.md`),
				});
			}
			return targets;
		}
		case "cursor":
			return [{ kind: "spec", relPath: join(".cursor", "skills", name, "SKILL.md") }];
		case "opencode":
			return [{ kind: "spec", relPath: join(".opencode", "skills", name, "SKILL.md") }];
		case "pi":
			return [{ kind: "spec", relPath: join(".pi", "skills", name, "SKILL.md") }];
		default:
			return [];
	}
}

/** Render the content for one runner target: the SKILL.md verbatim, or the alias body. */
export function renderTargetContent(
	config: SkillRenderConfig,
	target: RunnerSkillTarget,
	skillContent: string,
): string {
	switch (target.kind) {
		case "spec":
			return skillContent;
		case "copilot-prompt-alias":
			return config.copilotPromptAlias ?? skillContent;
	}
}
