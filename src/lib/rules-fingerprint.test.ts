// ===========================================
// rules-fingerprint unit tests
// ===========================================
// Two repos judged by the same rules must produce the same hash; any change to
// a water-line, a guard rule, or a suppression must change it. Fixture repos
// are built in an OS temp dir so no committed baseline leaks into the oracle.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RULES_FINGERPRINT_SCHEMA, computeRulesFingerprint, findRulesRoot } from "./rules-fingerprint.js";

const roots: string[] = [];

function repo(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "il-rules-fp-"));
	roots.push(root);
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	// The committed marker of a guarded repo; without it (or `.git`) a directory is not a rules root.
	writeFileSync(join(root, ".interlinked", "config.json"), "{}\n");
	for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("computeRulesFingerprint", () => {
	it("P1: a bare repo yields a sha256-prefixed hash, the defaults as inputs, and the schema tag", () => {
		const fp = computeRulesFingerprint(repo());
		expect(fp.schema).toBe(RULES_FINGERPRINT_SCHEMA);
		expect(fp.rules_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(fp.inputs.metric_caps.max_cyclomatic.source).toBe("default");
		expect(fp.inputs.guard_rules_files).toEqual({ team: false, local: false });
		expect(fp.inputs.suppressions).toBe(0);
	});

	it("P2: two repos with identical rules hash identically — the hash is a function of the rules, not the path", () => {
		const a = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12}' }));
		const b = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12}' }));
		expect(a.rules_hash).toBe(b.rules_hash);
		expect(a.inputs.metric_caps.max_cyclomatic).toEqual({ value: 12, source: "metric-caps.json" });
	});

	it("P3: tightening one cap changes the hash", () => {
		const loose = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":16}' }));
		const tight = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12}' }));
		expect(loose.rules_hash).not.toBe(tight.rules_hash);
	});

	it("P4: a local guard-rules override changes the hash and is reported as present", () => {
		const plain = computeRulesFingerprint(repo());
		const overridden = computeRulesFingerprint(
			repo({ ".interlinked/guard-rules.local.json": '{"disabled_rules":["builtin-sleep-detection"]}' }),
		);
		expect(overridden.inputs.guard_rules_files).toEqual({ team: false, local: true });
		expect(overridden.rules_hash).not.toBe(plain.rules_hash);
	});

	it("P5: a verify suppression changes the hash and is counted", () => {
		const plain = computeRulesFingerprint(repo());
		const suppressed = computeRulesFingerprint(
			repo({
				".interlinked/verify-suppressions.json": JSON.stringify({
					"src/a.ts": { magic_number: { reason: "calibrated constant", by: "qcody", at: "2026-09-21" } },
				}),
			}),
		);
		expect(suppressed.inputs.suppressions).toBe(1);
		expect(suppressed.rules_hash).not.toBe(plain.rules_hash);
	});

	it("N1: key order inside a rules file does not change the hash (canonical JSON)", () => {
		const a = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12,"max_cognitive":10}' }));
		const b = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": '{"max_cognitive":10,"max_cyclomatic":12,"version":1}' }));
		expect(a.rules_hash).toBe(b.rules_hash);
	});

	it("P6: a subdirectory target resolves to the repo's rules root, so verify on a subtree hashes the same rules", () => {
		const root = repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12}' });
		mkdirSync(join(root, "src", "lib"), { recursive: true });
		const fromSub = computeRulesFingerprint(join(root, "src", "lib"));
		expect(fromSub.rules_hash).toBe(computeRulesFingerprint(root).rules_hash);
		expect(fromSub.inputs.metric_caps.max_cyclomatic.value).toBe(12);
		expect(findRulesRoot(join(root, "src", "lib"))).toBe(root);
	});

	it("N4: an artifact-only nested .interlinked (no config.json, no .git) does not capture the root", () => {
		const root = repo({ ".interlinked/metric-caps.json": '{"version":1,"max_cyclomatic":12}' });
		mkdirSync(join(root, "src", "lib", ".interlinked"), { recursive: true });
		writeFileSync(join(root, "src", "lib", ".interlinked", "verify-runs.jsonl"), "");
		expect(findRulesRoot(join(root, "src", "lib"))).toBe(root);
		expect(computeRulesFingerprint(join(root, "src", "lib")).inputs.metric_caps.max_cyclomatic.value).toBe(12);
	});

	it("N3: with no .interlinked anywhere above, the start directory itself is the root (defaults, no throw)", () => {
		const bare = mkdtempSync(join(tmpdir(), "il-rules-fp-bare-"));
		roots.push(bare);
		expect(findRulesRoot(bare)).toBe(bare);
		expect(computeRulesFingerprint(bare).inputs.metric_caps.max_cyclomatic.source).toBe("default");
	});

	it("N2: an unparseable rules file falls back to defaults instead of throwing", () => {
		const fp = computeRulesFingerprint(repo({ ".interlinked/metric-caps.json": "{not json" }));
		expect(fp.rules_hash).toMatch(/^sha256:/);
		expect(fp.inputs.metric_caps.max_cyclomatic.source).toBe("default");
	});
});
