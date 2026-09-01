// ===========================================
// T2 toolchain manifest — pin what the sandbox must reproduce
// ===========================================
// Tool outputs are part of the environment: an on-policy rollout is only
// deterministic if the sandbox runs the SAME node/git/tsc/biome/vitest and
// the same resolved dependency set. This records those identities at capture
// time; the sandbox image pins to them
// (docs/design/reproducibility/tier2-onpolicy-env.md). Version lookups are
// injectable (tests never spawn); the default shells out best-effort — a
// missing tool records null, never a guess.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOOLCHAIN_TOOLS: readonly string[] = ["git", "tsgo", "biome", "vitest", "node"];

interface ToolchainManifest {
	schema: "toolchain-manifest.v1";
	captured_at: string;
	/** The capturing process's own node — authoritative, no spawn needed. */
	node: string;
	/** First line of `<tool> --version`, or null when the tool is absent. */
	tools: Record<string, string | null>;
	/** sha256 of package-lock.json — the resolved dependency identity. */
	lockfile_sha256: string | null;
}

function defaultVersionOf(cwd: string): (tool: string) => string | null {
	return (tool) => {
		try {
			const out = execFileSync("npx", ["--no-install", tool, "--version"], {
				cwd,
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return out.split("\n")[0]?.trim() || null;
		} catch (err) {
			void err; // absent tool → null (never a guess)
			return null;
		}
	};
}

export function captureToolchainManifest(
	cwd: string,
	opts: { versionOf?: (tool: string) => string | null; now?: () => string } = {},
): ToolchainManifest {
	const versionOf = opts.versionOf ?? defaultVersionOf(cwd);
	const now = opts.now ?? (() => new Date().toISOString());
	const tools: Record<string, string | null> = {};
	for (const tool of TOOLCHAIN_TOOLS) {
		tools[tool] = tool === "node" ? process.version : versionOf(tool);
	}
	// The test stub returns null for non-git tools including "node"'s spawn —
	// but node is always self-reported above, so keep that authoritative.
	tools.node = process.version;
	const lockfile = join(cwd, "package-lock.json");
	return {
		schema: "toolchain-manifest.v1",
		captured_at: now(),
		node: process.version,
		tools,
		lockfile_sha256: existsSync(lockfile)
			? createHash("sha256").update(readFileSync(lockfile)).digest("hex")
			: null,
	};
}

/** Persist the manifest for the current repo state. */
export function recordToolchainManifest(cwd: string): ToolchainManifest {
	const manifest = captureToolchainManifest(cwd);
	const path = join(cwd, ".interlinked", "replay", "toolchain-manifest.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(manifest, null, 2));
	return manifest;
}
