// ===========================================
// Skill install templates — per-runner content rendering (pure)
// ===========================================
// The "what content goes into each runner's file" half of the skill installer.
// No filesystem here — `skill-installers.ts` owns I/O; this module owns the
// enforce-specific description swap + Copilot alias template and the per-runner
// target layout. Split out of `skill-installers.ts` so both stay well under the
// per-file line cap.

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
	/** Runners with strict description limits get this shorter description. */
	shortDescription?: string;
	/** Copilot `.prompt.md` alias body (slash-command runners only). */
	copilotPromptAlias?: string;
}

/** Runners whose SKILL.md copies must keep a parser-safe description length. */
export const RUNNERS_REQUIRING_SHORT_DESCRIPTION: ReadonlySet<ClientName> = new Set([
	"claude",
	"codex",
	"gemini",
	"copilot",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
]);

/**
 * Several skill loaders reject descriptions over 1024 characters. The `enforce`
 * skill's authored description exceeds that, so its runner-facing copies get
 * this trimmed variant. (The interlinked-* teaching skills author descriptions
 * well under 1024, so they need no swap — they ship their own verbatim.)
 */
export const ENFORCE_SHORT_DESCRIPTION =
	"Distill imperative markdown guidance (AGENTS.md, CLAUDE.md, .clinerules/, GEMINI.md, SKILL.md with hard imperatives) into Interlinked harness hook rules with verbatim source provenance. Invoke as /enforce with a local path, directory, GitHub shorthand (owner/repo/path), URL, or no argument to walk the project. Lexical strength is binding: never/MUST NOT/forbidden distill to block; should not/avoid to ask; should/prefer to advisory; hedged language is skipped. Output goes to .interlinked/distilled-rules.json plus .interlinked/distilled-rules.overrides.json. Lifecycle ops: /enforce list, show, remove, disable, enable, modify, add, reset, --review, --accept. Description-match invocation: make my AGENTS.md enforced, distill rules from this file. Manual invocation only — never auto-fires.";

/** Thin prompt-file alias for Copilot surfaces that still read .prompt.md files. */
export const ENFORCE_COPILOT_PROMPT_ALIAS = `---
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

/** YAML double-quoted scalar — escape backslashes and double quotes only. */
export function quoteYamlDouble(s: string): string {
	const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/**
 * The per-skill render config. `enforce` gets its length-limited description and
 * hand-written Copilot alias; every other skill ships verbatim to native skill
 * directories and does not need a compatibility alias.
 */
export function buildSkillConfig(name: string): SkillRenderConfig {
	if (name === "enforce") {
		return {
			shortDescription: ENFORCE_SHORT_DESCRIPTION,
			copilotPromptAlias: ENFORCE_COPILOT_PROMPT_ALIAS,
		};
	}
	return {};
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
		case "opencode2":
			return [{ kind: "spec", relPath: join(".opencode", "skills", name, "SKILL.md") }];
		case "pi":
			return [{ kind: "spec", relPath: join(".pi", "skills", name, "SKILL.md") }];
		default:
			return [];
	}
}

/** Render the content for one runner target (description swap / alias body). */
export function renderTargetContent(
	client: ClientName,
	config: SkillRenderConfig,
	target: RunnerSkillTarget,
	skillContent: string,
): string {
	switch (target.kind) {
		case "spec":
			return config.shortDescription && RUNNERS_REQUIRING_SHORT_DESCRIPTION.has(client)
				? swapFrontmatterDescription(skillContent, config.shortDescription)
				: skillContent;
		case "copilot-prompt-alias":
			return config.copilotPromptAlias ?? skillContent;
	}
}

/**
 * Replace the YAML frontmatter `description` field with `newDescription`,
 * leaving the body and other frontmatter keys (name, etc.) untouched. Handles
 * both inline-style (`description: foo`) and block-scalar style (`description: |`
 * with indented continuation lines). Returns content unchanged when no
 * frontmatter is present (defensive — should not happen with our shipped skill).
 */
export function swapFrontmatterDescription(content: string, newDescription: string): string {
	const DELIM = "---\n";
	if (!content.startsWith(DELIM)) return content;
	const closeIdx = content.indexOf(`\n${DELIM}`, DELIM.length);
	if (closeIdx < 0) return content;

	const frontmatter = content.slice(DELIM.length, closeIdx + 1);
	const body = content.slice(closeIdx + 1 + DELIM.length);

	const lines = frontmatter.split("\n");
	const out: string[] = [];
	let i = 0;
	let replaced = false;
	const quoted = quoteYamlDouble(newDescription);

	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i += 1;
			continue;
		}
		if (!replaced && /^description\s*:/.test(line)) {
			out.push(`description: ${quoted}`);
			replaced = true;

			// If the original used a block scalar (`|`, `>`, with optional chomp
			// indicators `+`/`-`), consume the indented/blank continuation lines.
			const valuePart = line.slice(line.indexOf(":") + 1).trim();
			const isBlockScalar = /^[|>][+-]?$/.test(valuePart);
			i += 1;
			if (isBlockScalar) {
				while (i < lines.length) {
					const next = lines[i];
					if (next === undefined) break;
					if (next.length === 0 || /^\s/.test(next)) {
						i += 1;
						continue;
					}
					break;
				}
			}
			continue;
		}
		out.push(line);
		i += 1;
	}

	if (!replaced) {
		out.push(`description: ${quoted}`);
	}

	// The `\n` between the joined frontmatter and the closing `---\n` is
	// significant — dropping it produces malformed YAML where the last value
	// runs into the closing delimiter. Preserve it explicitly.
	return `${DELIM}${out.join("\n")}\n${DELIM}${body}`;
}
