import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMetacoderContext } from "./prompt-builder.js";
import { DEFAULT_METACODER_CONFIG } from "./types.js";

const FLOOR_RULE_IDS = ["block_rm_rf", "no_force_push"];

describe("buildMetacoderContext", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-prompt-"));
	});

	it("returns the prompt verbatim", () => {
		const ctx = buildMetacoderContext({
			prompt: "Refactor the payment service.",
			client: "claude",
			sessionId: "abc",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.prompt).toBe("Refactor the payment service.");
		expect(ctx.client).toBe("claude");
		expect(ctx.session_id).toBe("abc");
		expect(ctx.cwd).toBe(cwd);
	});

	it("populates overlay_prefix from the session id", () => {
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "barrel-session-abc12345",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		// Plan §reviewer-P1: the prefix the loader will enforce must be
		// passed literally so the metacoder can copy it byte-for-byte.
		// Slug is the first 12 chars of the sanitized session id.
		expect(ctx.overlay_prefix).toBe("overlay:barrel-sessi:");
	});

	it("forwards floor rule ids", () => {
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "codex",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.floor_rule_ids).toEqual(FLOOR_RULE_IDS);
	});

	it("concatenates AGENTS.md and CLAUDE.md into project_instructions", () => {
		writeFileSync(join(cwd, "AGENTS.md"), "# Agents guidance\nUse TypeScript.");
		writeFileSync(join(cwd, "CLAUDE.md"), "# Claude guidance\nNo console.log.");
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_instructions).toContain("Use TypeScript.");
		expect(ctx.project_instructions).toContain("No console.log.");
	});

	it("returns an empty project_instructions when no guidance files exist", () => {
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_instructions).toBe("");
	});

	it("caps project_instructions at the configured byte budget", () => {
		const huge = "x".repeat(40_000);
		writeFileSync(join(cwd, "AGENTS.md"), huge);
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		// Cap is generous (~20kB) but bounded — must be less than the raw input.
		expect(ctx.project_instructions.length).toBeLessThan(huge.length);
		expect(ctx.project_instructions.length).toBeLessThanOrEqual(25_000);
	});

	it("includes .clinerules/*.md when present", () => {
		mkdirSync(join(cwd, ".clinerules"), { recursive: true });
		writeFileSync(join(cwd, ".clinerules", "one.md"), "Rule one body.");
		writeFileSync(join(cwd, ".clinerules", "two.md"), "Rule two body.");
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_instructions).toContain("Rule one body.");
		expect(ctx.project_instructions).toContain("Rule two body.");
	});

	it("includes a project graph summary built from the real CatalogMeta schema", () => {
		// Plan §reviewer-P3 (round 6): fixture uses the schema actually
		// written by `structure/cache-manager.ts::writeCatalogMeta`.
		// `file_count` / `by_extension` do not exist on that schema.
		const cacheDir = join(cwd, ".interlinked", "structure-cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, "catalog-meta.json"),
			JSON.stringify({
				schema_version: 1,
				cli_version: "0.1.0",
				built_at: "2026-05-13T14:00:00Z",
				repo_root: cwd,
				last_scanned_commit: "abc12345deadbeef",
				manifest_hash: "sha256:fakefakefake",
				extractor_versions: { module: 1, package: 1 },
			}),
		);
		writeFileSync(
			join(cacheDir, "module.json"),
			JSON.stringify({
				schema_version: 1,
				items: Array.from({ length: 320 }, (_, i) => ({
					local_id: `m${i}`,
					global_ref: `gh:owner/repo/m${i}`,
					file: `src/mod${i}.ts`,
				})),
			}),
		);
		writeFileSync(
			join(cacheDir, "package.json"),
			JSON.stringify({
				schema_version: 1,
				items: Array.from({ length: 67 }, (_, i) => ({
					local_id: `p${i}`,
					global_ref: `gh:owner/repo/p${i}`,
					file: `pkg/${i}/package.json`,
				})),
			}),
		);
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_graph_summary).toBeDefined();
		expect(ctx.project_graph_summary).toContain("abc12345");
		expect(ctx.project_graph_summary).toContain("387");
	});

	it("returns a partial summary when only catalog-meta.json exists (no per-category caches)", () => {
		const cacheDir = join(cwd, ".interlinked", "structure-cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, "catalog-meta.json"),
			JSON.stringify({
				schema_version: 1,
				cli_version: "0.1.0",
				built_at: "2026-05-13T14:00:00Z",
				repo_root: cwd,
				last_scanned_commit: "abc12345",
				manifest_hash: "sha256:x",
				extractor_versions: {},
			}),
		);
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_graph_summary).toBeDefined();
		expect(ctx.project_graph_summary).toContain("abc12345");
		expect(ctx.project_graph_summary).not.toMatch(/items/);
	});

	it("returns undefined when catalog-meta.json schema_version is wrong", () => {
		const cacheDir = join(cwd, ".interlinked", "structure-cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, "catalog-meta.json"),
			JSON.stringify({ schema_version: 2, last_scanned_commit: "abc" }),
		);
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_graph_summary).toBeUndefined();
	});

	it("omits project graph summary when the cache is missing", () => {
		const ctx = buildMetacoderContext({
			prompt: "p",
			client: "claude",
			sessionId: "s",
			cwd,
			floorRuleIds: FLOOR_RULE_IDS,
			config: DEFAULT_METACODER_CONFIG,
		});
		expect(ctx.project_graph_summary).toBeUndefined();
	});
});
