// ===========================================
// installed-hooks-verify — semantic verification of one runner's install
// ===========================================
// Review 2026-08-30 P0: refresh's "verified" was a substring search — a file
// containing only {"unrelated_note": "/new/binary"} verified. The semantic
// verifier proves the install's SHAPE: every expected native event exactly
// once, deregistered events absent, owned commands on the current binary,
// Codex's feature flag on, and the manifest row matching.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks, manifestPath, readManifest, resolveSettingsPath } from "./installer.js";
import { verifyInstalledRunner } from "./installed-hooks-verify.js";

let cwd: string;
const BINARY = "/opt/interlinked/bin/hook-entry.js";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "il-verify-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function installedEntry(runner: "gemini-cli" | "codex" | "cursor") {
	const result = installHooks({ cwd, binaryPath: BINARY, runners: [runner], scope: "project" });
	expect(result.ok).toBe(true);
	const entry = readManifest(manifestPath(cwd)).find((e) => e.runner === runner);
	expect(entry).toBeDefined();
	// SAFETY: asserted defined on the line above.
	return entry as NonNullable<typeof entry>;
}

describe("verifyInstalledRunner — positive (a real install verifies)", () => {
	// test-contract: public-api — a fresh real install passes every check.
	it("P1: a fresh gemini-cli install verifies with no problems", () => {
		const entry = installedEntry("gemini-cli");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.problems).toEqual([]);
		expect(v.verified).toBe(true);
	});

	// test-contract: public-api — codex includes the [features] hooks flag.
	it("P2: a fresh codex install verifies, including config.toml", () => {
		const entry = installedEntry("codex");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.problems).toEqual([]);
		expect(v.verified).toBe(true);
	});

	it("P3: canonical hook text in unrelated metadata is not an installed stale command", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as Record<string, unknown>;
		raw.unrelated_note =
			'node "/old/dist/hook-entry.js" --runner "gemini-cli" --event "BeforeTool"';
		writeFileSync(entry.settings_path, JSON.stringify(raw));
		const verification = verifyInstalledRunner(cwd, entry, BINARY);
		expect(verification).toMatchObject({ verified: true, problems: [] });
	});

	it("P4: object key order does not make a structurally identical hook stale", () => {
		const entry = installedEntry("codex");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		const firstEventEntries = Object.values(raw.hooks)[0];
		const firstEntry = firstEventEntries?.[0];
		expect(firstEntry).not.toBeNull();
		expect(typeof firstEntry).toBe("object");
		expect(Array.isArray(firstEntry)).toBe(false);
		// SAFETY: the assertions above narrow this installed hook entry to a non-null, non-array object.
		const firstEntryRecord = firstEntry as Record<string, unknown>;
		expect(firstEventEntries).toBeDefined();
		// SAFETY: asserted defined on the line above.
		(firstEventEntries as unknown[])[0] = Object.fromEntries(
			Object.entries(firstEntryRecord).reverse(),
		);
		writeFileSync(entry.settings_path, JSON.stringify(raw));

		const verification = verifyInstalledRunner(cwd, entry, BINARY);
		expect(verification).toMatchObject({ verified: true, problems: [] });
	});
});

describe("verifyInstalledRunner — negative (must fail)", () => {
	// test-contract: bug — the reviewer's repro: a file whose only relation to
	// the binary is a substring must NOT verify.
	it("N1: a hook-less file containing the binary path as prose fails", () => {
		const entry = installedEntry("gemini-cli");
		writeFileSync(entry.settings_path, JSON.stringify({ unrelated_note: BINARY }));
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.length).toBeGreaterThan(0);
	});

	// test-contract: invariant — a MISSING expected event fails verification.
	it("N2: a settings file missing one owned event fails", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as {
			hooks: Record<string, unknown>;
		};
		delete raw.hooks.AfterTool;
		writeFileSync(entry.settings_path, JSON.stringify(raw));
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("AfterTool");
	});

	// test-contract: invariant — an owned command still on an OLD binary fails
	// (the stale install the refresh exists to repair).
	it("N3: an owned command on a stale binary path fails", () => {
		const entry = installedEntry("gemini-cli");
		const v = verifyInstalledRunner(cwd, entry, "/opt/interlinked/bin/hook-entry-v2.js");
		expect(v.verified).toBe(false);
	});

	// test-contract: invariant — a codex install whose feature flag was turned
	// back off fails.
	it("N4: codex with [features] hooks=false fails", () => {
		const entry = installedEntry("codex");
		writeFileSync(join(cwd, ".codex", "config.toml"), "[features]\nhooks = false\n");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("hooks = true");
	});

	// test-contract: bug — review 2026-08-30 (second pass) repro: duplicate
	// [features] tables are invalid TOML Codex rejects wholesale, yet the
	// last-value reader called the config verified. It must fail.
	it("N9: codex with duplicate [features] tables fails", () => {
		const entry = installedEntry("codex");
		writeFileSync(
			join(cwd, ".codex", "config.toml"),
			"[features]\nhooks = false\n\n[features]\nhooks = true\n",
		);
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("duplicate [features]");
	});

	// test-contract: boundary — a manifest row whose binary_path disagrees
	// with the expected binary fails (drift between record and expectation).
	it("N5: a manifest entry recording a different binary fails", () => {
		const entry = installedEntry("gemini-cli");
		const drifted = { ...entry, binary_path: "/elsewhere/hook.js" };
		const v = verifyInstalledRunner(cwd, drifted, BINARY);
		expect(v.verified).toBe(false);
	});

	// test-contract: bug — review 2026-08-30 repro: a VALID hooks object moved
	// under `unrelated_note` with the real hooks property deleted verified
	// under the string-collecting version. Structural verification requires
	// the entries at their NATIVE paths.
	it("N6: hooks moved under an unrelated key (real hooks deleted) fail", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as Record<string, unknown>;
		const moved = { unrelated_note: raw.hooks };
		writeFileSync(entry.settings_path, JSON.stringify(moved));
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.length).toBeGreaterThan(0);
	});

	// test-contract: bug — review 2026-08-30 (second pass) repro: an OLD
	// Interlinked hook (different binary path, different quoting) parked
	// under an undeclared event key (hooks.Obsolete) verified. Ownership is
	// now the CANONICAL recognizer, so any owned command outside the
	// adapter's current render fails.
	it("N8: a stale old-binary Interlinked hook at an undeclared event fails", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as {
			hooks: Record<string, unknown>;
		};
		raw.hooks.Obsolete = [
			{ command: 'node "/some/old/dist/hook-entry.js" --runner "gemini-cli" --event "Obsolete"' },
		];
		writeFileSync(entry.settings_path, JSON.stringify(raw));
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("stale Interlinked-owned command");
	});

	it("N10: a prototype-name native key is not mistaken for an adapter declaration", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as {
			hooks: Record<string, unknown>;
		};
		// Reusing a real current-binary entry prevents the independent stale-command
		// sweep from hiding the declaration bug this regression isolates.
		const firstNativeEntries = Object.values(raw.hooks)[0];
		expect(firstNativeEntries).toBeDefined();
		raw.hooks["constructor"] = firstNativeEntries;
		writeFileSync(entry.settings_path, JSON.stringify(raw));

		const verification = verifyInstalledRunner(cwd, entry, BINARY);
		expect(verification.verified).toBe(false);
		expect(verification.problems.join(" ")).toContain("hooks.constructor");
	});

	// test-contract: bug — review 2026-08-30 repro: `[other] hooks = true`
	// with no valid `[features]` assignment verified under the document-wide
	// regex. The table-aware reader must fail it.
	it("N7: codex with hooks=true only under [other] fails", () => {
		const entry = installedEntry("codex");
		writeFileSync(join(cwd, ".codex", "config.toml"), "[other]\nhooks = true\n");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("[features]");
	});

	it("an extra owned hook entry beyond the adapter's expected shape fails with a count-mismatch message", () => {
		const entry = installedEntry("gemini-cli");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as {
			hooks: Record<string, Array<{ command: string }>>;
		};
		const original = raw.hooks.BeforeTool?.[0];
		expect(original).toBeDefined();
		// SAFETY: asserted defined on the line above. Same binary, a different
		// --event flag value: still recognized as owned (ownership does not
		// check the event value), but no longer structurally equal to the
		// adapter's single expected BeforeTool entry.
		const duplicateOnOtherEvent = {
			command: (original as { command: string }).command.replace("--event 'BeforeTool'", "--event 'AfterTool'"),
		};
		raw.hooks.BeforeTool = [original as { command: string }, duplicateOnOtherEvent];
		writeFileSync(entry.settings_path, JSON.stringify(raw));

		const verification = verifyInstalledRunner(cwd, entry, BINARY);
		expect(verification.verified).toBe(false);
		expect(verification.problems.join(" ")).toContain(
			"hooks.BeforeTool: 1 extra owned hook entr(ies) beyond the adapter's expected shape",
		);
	});

	it("a tampered primitive leaf in the fragment (cursor's version field) reports the expected-vs-found mismatch", () => {
		const entry = installedEntry("cursor");
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const raw = JSON.parse(readFileSync(entry.settings_path, "utf-8")) as Record<string, unknown>;
		raw.version = 2;
		writeFileSync(entry.settings_path, JSON.stringify(raw));

		const verification = verifyInstalledRunner(cwd, entry, BINARY);
		expect(verification.verified).toBe(false);
		expect(verification.problems).toContain("version: expected 1, found 2");
	});

	it("codex with two hooks assignments inside one [features] table fails on the duplicate-assignment message, not the duplicate-table one", () => {
		const entry = installedEntry("codex");
		writeFileSync(join(cwd, ".codex", "config.toml"), "[features]\nhooks = true\nhooks = false\n");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.join(" ")).toContain("duplicate hooks/codex_hooks assignments in [features]");
		expect(v.problems.join(" ")).not.toContain("duplicate [features] tables");
	});

	it("a managed-provider-file runner (opencode) with no file on disk yet reports it missing", () => {
		const settingsPath = resolveSettingsPath(cwd, ".opencode/plugins/interlinked.ts");
		const entry = { runner: "opencode" as const, settings_path: settingsPath, scope: "project" };
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems).toContain(`managed provider file missing: ${settingsPath}`);
	});

	it("a managed-provider-file path that is a directory (unreadable as text) fails with the read-error message", () => {
		const settingsPath = resolveSettingsPath(cwd, ".pi/extensions/interlinked.js");
		mkdirSync(settingsPath, { recursive: true });
		const entry = { runner: "pi" as const, settings_path: settingsPath, scope: "project" };
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.some((p) => p.startsWith("managed provider file unreadable: "))).toBe(true);
	});

	it("a managed-provider-file path holding foreign (non-Interlinked) content fails as not managed", () => {
		const settingsPath = resolveSettingsPath(cwd, ".opencode/plugins/interlinked.ts");
		mkdirSync(join(cwd, ".opencode", "plugins"), { recursive: true });
		writeFileSync(settingsPath, "export default {};\n");
		const entry = { runner: "opencode" as const, settings_path: settingsPath, scope: "project" };
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems).toContain(`${settingsPath} is not an Interlinked-managed provider file`);
	});

	it("a json-settings runner (gemini-cli) with no settings file on disk yet reports it missing", () => {
		const settingsPath = resolveSettingsPath(cwd, ".gemini/settings.json");
		const entry = { runner: "gemini-cli" as const, settings_path: settingsPath, scope: "project" };
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems).toContain(`settings file missing: ${settingsPath}`);
	});

	it("a settings file containing invalid JSON fails with the parse-error message", () => {
		const entry = installedEntry("gemini-cli");
		writeFileSync(entry.settings_path, "{ this is not json");
		const v = verifyInstalledRunner(cwd, entry, BINARY);
		expect(v.verified).toBe(false);
		expect(v.problems.some((p) => p.startsWith("settings file unparseable: "))).toBe(true);
	});
});
