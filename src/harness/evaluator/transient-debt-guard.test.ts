import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../check-engine/types.js";
import { readOpenTransientDebts } from "../obligation-ledger-io.js";
import { applyTransientDebt, deferrableFromTsc } from "./transient-debt-guard.js";

let root = "";

function tsc(ruleId: string, line = 3, message = "declared but never read"): CheckResult {
	return { tool: "tsc", severity: "warning", file: "a.ts", ruleId, line, message } as CheckResult;
}

function run(over: {
	file?: string;
	findings?: CheckResult[] | null;
	config?: { mode?: "block" | "warn" | "off"; enabled?: boolean; slack?: number };
}) {
	return applyTransientDebt({
		filePath: join(root, over.file ?? "src/a.ts"),
		projectRoot: root,
		sessionId: "s1",
		findings: deferrableFromTsc(over.findings === undefined ? [] : over.findings),
		content: "content",
		...(over.config === undefined ? {} : { config: over.config }),
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "transient-debt-"));
	mkdirSync(join(root, "src"), { recursive: true });
});

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_TRANSIENT_DEBT;
	rmSync(root, { recursive: true, force: true });
});

describe("deferrableFromTsc — positive (must fire)", () => {
	it("P1: a demoted code is deferrable", () => {
		expect(deferrableFromTsc([tsc("TS6133")])).toEqual([
			{ detector: "TS6133", line: 3, message: "declared but never read" },
		]);
	});

	it("P2: unresolved-symbol codes are deferrable", () => {
		expect(deferrableFromTsc([tsc("TS2304")])).toHaveLength(1);
	});
});

describe("deferrableFromTsc — negative (must not fire)", () => {
	it("N1: a hard type error is not deferrable", () => {
		expect(deferrableFromTsc([tsc("TS2322")])).toEqual([]);
	});

	it("N2: null in, null out — 'did not run' must not read as 'clean'", () => {
		expect(deferrableFromTsc(null)).toBeNull();
		expect(deferrableFromTsc(undefined)).toBeNull();
	});
});

describe("applyTransientDebt — lifecycle over a real ledger", () => {
	it("P1: a deferrable finding opens a debt and lets the write through", () => {
		const out = run({ findings: [tsc("TS6133")] });
		expect(out.decision).toBeNull();
		const debts = readOpenTransientDebts(root);
		expect(debts).toHaveLength(1);
		expect(debts[0]).toMatchObject({ file: "src/a.ts", detector: "TS6133" });
	});

	it("P2: a clean re-edit of the same file discharges it", () => {
		run({ findings: [tsc("TS6133")] });
		run({ findings: [] });
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("P3: one wander is free, the second blocks", () => {
		run({ findings: [tsc("TS6133")] });
		expect(run({ file: "src/b.ts", findings: [] }).decision).toBeNull();
		const second = run({ file: "src/c.ts", findings: [] });
		expect(second.decision?.decision).toBe("block");
		expect(second.decision?.rule_id).toBe("transient_debt");
		expect(second.decision?.reason).toContain("src/a.ts");
	});

	it("P4: reconciling after the first wander clears the debt — no block follows", () => {
		run({ findings: [tsc("TS6133")] });
		run({ file: "src/b.ts", findings: [] });
		run({ findings: [] }); // back to src/a.ts, finding gone
		expect(readOpenTransientDebts(root)).toHaveLength(0);
		expect(run({ file: "src/c.ts", findings: [] }).decision).toBeNull();
	});
});

describe("applyTransientDebt — must not fire", () => {
	it("N1: a hard type error opens no debt (it already blocks elsewhere)", () => {
		run({ findings: [tsc("TS2322")] });
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("N2: the env bypass disables the whole lifecycle", () => {
		process.env.INTERLINKED_DISABLE_TRANSIENT_DEBT = "1";
		expect(run({ findings: [tsc("TS6133")] }).decision).toBeNull();
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("N3: enabled:false disables it", () => {
		run({ findings: [tsc("TS6133")], config: { enabled: false } });
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("N4: warn mode never blocks, however far the agent wanders", () => {
		run({ findings: [tsc("TS6133")], config: { mode: "warn" } });
		run({ file: "src/b.ts", findings: [], config: { mode: "warn" } });
		const third = run({ file: "src/c.ts", findings: [], config: { mode: "warn" } });
		expect(third.decision).toBeNull();
	});

	it("N5: another session's debt never blocks this one (observed live on landing)", () => {
		// A parallel session opens a debt and wanders past its slack.
		applyTransientDebt({
			filePath: join(root, "src/other.ts"),
			projectRoot: root,
			sessionId: "other-session",
			findings: [{ detector: "TS2304", line: 1, message: "Cannot find name 'x'" }],
			content: "c",
		});
		applyTransientDebt({
			filePath: join(root, "src/p.ts"),
			projectRoot: root,
			sessionId: "other-session",
			findings: [],
			content: "c",
		});
		// This session cannot re-run that file's checker on the other session's
		// behalf, so its debt must be invisible here — otherwise the block is a
		// permanent stop with no action that clears it.
		expect(run({ file: "src/q.ts", findings: [] }).decision).toBeNull();
		expect(run({ file: "src/r.ts", findings: [] }).decision).toBeNull();
	});

	it("N6: an overlay that did not run discharges nothing", () => {
		run({ findings: [tsc("TS6133")] });
		run({ findings: null }); // same file, but tsc had no answer
		expect(readOpenTransientDebts(root)).toHaveLength(1);
	});

	it("N7: an explicit mode:'off' in config disables it same as enabled:false", () => {
		run({ findings: [tsc("TS6133")], config: { mode: "off" } });
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});
});

describe("applyTransientDebt — explicit config.mode and slack", () => {
	it("explicit mode:'block' behaves like the default block mode", () => {
		run({ findings: [tsc("TS6133")], config: { mode: "block" } });
		run({ file: "src/b.ts", findings: [], config: { mode: "block" } });
		const second = run({ file: "src/c.ts", findings: [], config: { mode: "block" } });
		expect(second.decision?.decision).toBe("block");
	});

	it("a larger slack tolerates more unrelated wanders before blocking", () => {
		run({ findings: [tsc("TS6133")], config: { slack: 2 } });
		expect(run({ file: "src/b.ts", findings: [], config: { slack: 2 } }).decision).toBeNull();
		expect(run({ file: "src/c.ts", findings: [], config: { slack: 2 } }).decision).toBeNull();
		const third = run({ file: "src/d.ts", findings: [], config: { slack: 2 } });
		expect(third.decision?.decision).toBe("block");
	});
});

describe("applyTransientDebt — repoRelative path handling", () => {
	it("records the debt with a forward-slash, repo-relative path for nested files", () => {
		mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
		const out = applyTransientDebt({
			filePath: join(root, "src", "nested", "deep", "z.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: deferrableFromTsc([tsc("TS6133")]),
			content: "content",
		});
		expect(out.decision).toBeNull();
		const debts = readOpenTransientDebts(root);
		expect(debts[0]?.file).toBe("src/nested/deep/z.ts");
	});
});

// `interlinked harness test --write` computes a verdict for content that is
// never written. Persisting from it opened a real TS2305 debt on a file the
// probe never touched, which then blocked an unrelated edit (2026-08-04).
describe("applyTransientDebt — dry run persists nothing", () => {
	const dryRun = (findings: CheckResult[] | null) =>
		applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			dryRun: true,
			findings: deferrableFromTsc(findings ?? []),
			content: "content",
		});

	it("still returns the verdict and warnings", () => {
		const result = dryRun([tsc("TS6133")]);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("opens no debt", () => {
		dryRun([tsc("TS6133")]);
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("cannot discharge a real debt either", () => {
		run({ findings: [tsc("TS6133")] });
		expect(readOpenTransientDebts(root)).toHaveLength(1);
		dryRun([]);
		expect(readOpenTransientDebts(root)).toHaveLength(1);
	});
});

describe("repoRelative — nested-path normalization", () => {
	it("converts embedded backslash separators to forward slashes in the recorded path", () => {
		mkdirSync(join(root, "src"), { recursive: true });
		// `join` on POSIX treats a backslash as a literal character, not a
		// separator, so this path segment reaches resolve()/relative() carrying
		// real backslashes for repoRelative's `.replace(/\\/g, "/")` to convert.
		const weirdPath = join(root, "src", "windows\\style\\file.ts");
		const out = applyTransientDebt({
			filePath: weirdPath,
			projectRoot: root,
			sessionId: "s1",
			findings: deferrableFromTsc([tsc("TS6133")]),
			content: "content",
		});
		expect(out.decision).toBeNull();
		const debts = readOpenTransientDebts(root);
		expect(debts[0]?.file).toBe("src/windows/style/file.ts");
	});
});

describe("hashContent — recorded content hash", () => {
	it("hashes known content to its exact sha256-derived prefix, and different content differently", () => {
		const out1 = applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: deferrableFromTsc([tsc("TS6133")]),
			content: "content",
		});
		expect(out1.decision).toBeNull();
		const debts1 = readOpenTransientDebts(root);
		expect(debts1[0]?.contentHash).toBe("ed7002b439e9ac84");

		const out2 = applyTransientDebt({
			filePath: join(root, "src/other.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: deferrableFromTsc([tsc("TS2304")]),
			content: "other-content",
		});
		expect(out2.decision).toBeNull();
		const otherDebt = readOpenTransientDebts(root).find((d) => d.file === "src/other.ts");
		expect(otherDebt?.contentHash).toBe("bf0b46a021c53b9f");
		expect(otherDebt?.contentHash).not.toBe(debts1[0]?.contentHash);
	});
});

describe("applyTransientDebt — off mode returns the exact empty result", () => {
	it("off mode returns {decision:null, warnings:[]} exactly; block mode with the same finding does not", () => {
		const off = run({ findings: [tsc("TS6133")], config: { mode: "off" } });
		expect(off).toEqual({ decision: null, warnings: [] });
		expect(readOpenTransientDebts(root)).toHaveLength(0);

		const blocked = run({ findings: [tsc("TS6133")] }); // default block mode, fresh ledger
		expect(blocked.warnings.length).toBeGreaterThan(0);
		expect(blocked).not.toEqual({ decision: null, warnings: [] });
	});
});

describe("applyTransientDebt — empty-scope short circuit returns the exact empty result", () => {
	it("A: brand-new file, checker did not run, no open debts anywhere", () => {
		const out = applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: null,
			content: "content",
		});
		expect(out).toEqual({ decision: null, warnings: [] });
	});

	it("B: brand-new file, checker ran clean, no open debts anywhere", () => {
		const out = run({ findings: [] });
		expect(out).toEqual({ decision: null, warnings: [] });
	});
});

describe("applyTransientDebt — off mode diverges from block mode on the same non-trivial state", () => {
	it("off mode returns the exact empty result even when block mode would wander-warn on identical state", () => {
		run({ file: "src/other.ts", findings: [tsc("TS2304")] }); // opens a debt on other.ts, mode block

		const off = applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: [], // checker ran clean on a.ts
			content: "content",
			config: { mode: "off" },
		});
		expect(off).toEqual({ decision: null, warnings: [] });

		// Identical setup, only the mode differs — this run must wander-warn
		// about the still-open other.ts debt instead of coming back empty.
		const notOff = applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: [],
			content: "content",
			config: { mode: "block" },
		});
		expect(notOff).not.toEqual({ decision: null, warnings: [] });
		expect(notOff.warnings.length).toBeGreaterThan(0);
		expect(notOff.warnings[0]).toContain("src/other.ts");
	});
});

describe("applyTransientDebt — scoped filtering keeps OTHER files' debts in view", () => {
	it("a checker-silent edit still wanders from another file's open debt, and the strike persists", () => {
		run({ file: "src/other.ts", findings: [tsc("TS2304")] }); // opens a debt on other.ts

		const first = applyTransientDebt({
			filePath: join(root, "src/a.ts"),
			projectRoot: root,
			sessionId: "s1",
			findings: null, // a.ts's checker did not run this time
			content: "content",
		});
		expect(first.decision).toBeNull();
		expect(first.warnings).toHaveLength(1);
		expect(first.warnings[0]).toContain("src/other.ts");

		// The strike must be persisted, not just mentioned in a throwaway
		// warning: a second wander from a third file now blocks.
		const second = run({ file: "src/c.ts", findings: [] });
		expect(second.decision?.decision).toBe("block");
		expect(second.decision?.reason).toContain("src/other.ts");
	});

	it("a checker-silent edit on the file that owns the ONLY open debt short-circuits untouched", () => {
		run({ findings: [tsc("TS6133")] }); // debt on src/a.ts only
		const out = run({ findings: null }); // same file again, checker silent
		expect(out).toEqual({ decision: null, warnings: [] });
		expect(readOpenTransientDebts(root)).toHaveLength(1); // untouched, never discharged
	});
});
