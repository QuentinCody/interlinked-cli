import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OverlayRulesFile } from "./types.js";
import {
	evictOverlayForSession,
	writeOverlayArtifacts,
} from "./metacoder-writer.js";

const SESSION = "writer-test-abc12345";

function makeOverlay(): OverlayRulesFile {
	return {
		version: 1,
		session_id: SESSION,
		generated_at: "2026-05-13T14:00:00Z",
		generated_by: "metacoder",
		source_prompt_sha256: "deadbeefcafe",
		system_prompt_addendum: "Stay focused on the payment refactor.",
		rules: [
			{
				id: "overlay:writer-test-:0",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["Edit"],
				action: "block",
				patterns: [{ field: "file_path", regex: "src/legacy/" }],
				reason: "Out of scope.",
				severity: "high",
			},
		],
	};
}

describe("writeOverlayArtifacts", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-writer-"));
	});

	it("writes overlay-rules.json with the full overlay payload", () => {
		const result = writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		expect(result.rulesPath).toMatch(/overlay-rules\.json$/);
		const parsed = JSON.parse(readFileSync(result.rulesPath, "utf-8")) as OverlayRulesFile;
		expect(parsed.session_id).toBe(SESSION);
		expect(parsed.rules).toHaveLength(1);
		expect(parsed.rules[0].id).toBe("overlay:writer-test-:0");
	});

	it("writes system-prompt.md with the addendum", () => {
		const result = writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		expect(result.systemPromptPath).toMatch(/system-prompt\.md$/);
		expect(readFileSync(result.systemPromptPath, "utf-8")).toContain("payment refactor");
	});

	it("omits system-prompt.md when overlay has no addendum", () => {
		const overlay = makeOverlay();
		overlay.system_prompt_addendum = undefined;
		const result = writeOverlayArtifacts({ cwd, sessionId: SESSION }, overlay);
		expect(existsSync(result.systemPromptPath)).toBe(false);
	});

	it("overwrites prior artifacts atomically on replay (multi-prompt sessions)", () => {
		const first = writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		const second = makeOverlay();
		second.source_prompt_sha256 = "second-prompt-hash";
		second.system_prompt_addendum = "Now focus on the auth refactor.";
		writeOverlayArtifacts({ cwd, sessionId: SESSION }, second);
		const reloaded = JSON.parse(readFileSync(first.rulesPath, "utf-8")) as OverlayRulesFile;
		expect(reloaded.source_prompt_sha256).toBe("second-prompt-hash");
		expect(readFileSync(first.systemPromptPath, "utf-8")).toContain("auth refactor");
	});

	it("does not leave any .tmp* files in the session directory", () => {
		const result = writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		const dir = join(cwd, ".interlinked", "sessions");
		const entries = readdirSync(dir, { recursive: true }) as string[];
		const stragglers = entries.filter((name) => String(name).includes(".tmp"));
		expect(stragglers, `unexpected tmp files: ${stragglers.join(", ")}`).toHaveLength(0);
		expect(existsSync(result.rulesPath)).toBe(true);
	});

	it("creates the session directory if missing", () => {
		const fresh = mkdtempSync(join(tmpdir(), "metacoder-writer-fresh-"));
		const result = writeOverlayArtifacts({ cwd: fresh, sessionId: "brand-new" }, makeOverlay());
		expect(existsSync(result.rulesPath)).toBe(true);
	});
});

describe("evictOverlayForSession", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metacoder-evict-"));
	});

	it("removes the session overlay directory and its artifacts", () => {
		const result = writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		const sessionDir = result.rulesPath.replace(/\/overlay-rules\.json$/, "");
		expect(existsSync(sessionDir)).toBe(true);
		const removed = evictOverlayForSession({ cwd, sessionId: SESSION });
		expect(removed).toBe(true);
		expect(existsSync(sessionDir)).toBe(false);
	});

	it("returns false when the session directory does not exist", () => {
		const removed = evictOverlayForSession({ cwd, sessionId: "never-existed" });
		expect(removed).toBe(false);
	});

	it("returns false when the session id sanitizes to empty", () => {
		const removed = evictOverlayForSession({ cwd, sessionId: "////" });
		expect(removed).toBe(false);
	});

	it("does not touch sibling session directories", () => {
		writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		writeOverlayArtifacts({ cwd, sessionId: "other-session" }, makeOverlay());
		evictOverlayForSession({ cwd, sessionId: SESSION });
		const otherPath = join(cwd, ".interlinked", "sessions", "other-session", "overlay-rules.json");
		expect(existsSync(otherPath)).toBe(true);
	});

	it("does not touch unrelated files inside the .interlinked dir", () => {
		const interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		const sentinel = join(interlinkedDir, "config.json");
		writeFileSync(sentinel, "{}");
		writeOverlayArtifacts({ cwd, sessionId: SESSION }, makeOverlay());
		evictOverlayForSession({ cwd, sessionId: SESSION });
		expect(existsSync(sentinel)).toBe(true);
	});
});
