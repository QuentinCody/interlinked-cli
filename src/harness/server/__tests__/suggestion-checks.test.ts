import { nonNull } from "../../../lib/non-null.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSuggestionFindings, getSuggestionChecks } from "../suggestion-checks.js";

describe("collectSuggestionFindings", () => {
	it("returns an array (empty or populated) for clean TS code", () => {
		const findings = collectSuggestionFindings(
			"export function add(a: number, b: number): number { return a + b; }\n",
			"/tmp/test.ts",
		);
		expect(Array.isArray(findings)).toBe(true);
	});

	it("each finding has check, line, message, source fields", () => {
		// Code that should trip at least one heuristic (magic-number, silent catch)
		const code = `
			function handle(): number {
				try {
					return 42; // magic number, no context
				} catch {
					return 0;
				}
			}
		`;
		const findings = collectSuggestionFindings(code, "/tmp/test.ts");
		for (const f of findings) {
			expect(typeof f.check).toBe("string");
			expect(typeof f.line).toBe("number");
			expect(typeof f.message).toBe("string");
			expect(["security", "performance", "quality"]).toContain(f.source);
		}
	});

	it("does not throw on empty input", () => {
		expect(() => collectSuggestionFindings("", "/tmp/empty.ts")).not.toThrow();
	});

	it("surfaces a security finding with the detector's id, line, and source", () => {
		// `.query(`...${x}`)` is the canonical SQL-injection shape the
		// cross-language detector matches (template interpolation into a query call).
		const code = "function q(id) { return db.query(`SELECT * FROM t WHERE id = ${id}`); }\n";
		const findings = collectSuggestionFindings(code, "/tmp/db.ts");
		const sql = findings.find((f) => f.check === "sql-injection");
		expect(sql).toBeDefined();
		// The finding is wired with the registry's declared source category…
		expect(sql?.source).toBe("security");
		// …a 1-based line number (the match is on the first line)…
		expect(sql?.line).toBe(1);
		// …and the message is the offending source text the detector returned.
		expect(sql?.message).toContain("db.query(");
	});

	it("surfaces a quality finding for a nested ternary", () => {
		const code = "const v = a ? (b ? 1 : 2) : (c ? 3 : 4);\n";
		const findings = collectSuggestionFindings(code, "/tmp/t.ts");
		const nested = findings.find((f) => f.check === "nested-ternary");
		expect(nested).toBeDefined();
		expect(nested?.source).toBe("quality");
	});

	it("returns findings in registration order across multiple tripped checks", () => {
		// `db.query(`...${id}`)` (sql-injection, registered first) AND a nested
		// ternary (registered later). The aggregated output must preserve the
		// registry order, not detector-discovery order within the content.
		const code = [
			"function q(id) { return db.query(`SELECT * FROM t WHERE id = ${id}`); }",
			"const v = a ? (b ? 1 : 2) : (c ? 3 : 4);",
			"",
		].join("\n");
		const findings = collectSuggestionFindings(code, "/tmp/mixed.ts");
		const order = getSuggestionChecks().map((c) => c.check);
		const sqlIdx = findings.findIndex((f) => f.check === "sql-injection");
		const nestedIdx = findings.findIndex((f) => f.check === "nested-ternary");
		expect(sqlIdx).toBeGreaterThanOrEqual(0);
		expect(nestedIdx).toBeGreaterThanOrEqual(0);
		// sql-injection registers before nested-ternary, so it must appear first.
		expect(order.indexOf("sql-injection")).toBeLessThan(order.indexOf("nested-ternary"));
		expect(sqlIdx).toBeLessThan(nestedIdx);
	});

	// --- Slow-check performance telemetry branches ---
	//
	// These two branches only fire when a check (or the whole pass) crosses a
	// millisecond threshold. The detectors themselves do not call `Date.now()`
	// (verified: a full pass makes exactly `1 + 2N + 1` clock reads, where N is
	// the registry size), so a scripted `Date.now` deterministically drives the
	// timing without depending on real CPU speed.
	//
	// Clock-read order inside `collectSuggestionFindings`:
	//   index 0           -> collectionStart
	//   index 1 + 2*k     -> check k start (t0)
	//   index 2 + 2*k     -> check k end
	//   index 1 + 2*N     -> totalElapsed (final read)
	describe("slow-check telemetry", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		/**
		 * Installs a scripted `Date.now` and captures `process.stderr.write`.
		 * `elapsedByCheckIndex` maps a 0-based check index to the ms that check
		 * should appear to take; every other check appears instantaneous. The
		 * total is the sum of those deltas. Returns the captured stderr lines.
		 */
		function runWithScriptedTiming(
			elapsedByCheckIndex: Map<number, number>,
			content = "const x = 1;\n",
			filePath = "/tmp/perf.ts",
		): string[] {
			const checkCount = getSuggestionChecks().length;
			const startBase = 1_000;
			// Pre-compute the value returned at each clock index.
			const series: number[] = [];
			series.push(startBase); // index 0: collectionStart
			let clock = startBase;
			for (let k = 0; k < checkCount; k++) {
				series.push(clock); // start (t0) read for check k
				clock += elapsedByCheckIndex.get(k) ?? 0; // advance by this check's elapsed
				series.push(clock); // end read for check k
			}
			series.push(clock); // final: totalElapsed read

			let idx = 0;
			vi.spyOn(Date, "now").mockImplementation(() => {
				const v = series[idx] ?? clock;
				idx += 1;
				return v;
			});

			const writes: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation(
				(chunk: string | Uint8Array): boolean => {
					writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
					return true;
				},
			);

			collectSuggestionFindings(content, filePath);
			return writes;
		}

		it("logs a per-check line naming the slow check when it crosses the threshold", () => {
			// Make only the first registered check (index 0) appear to take 70ms
			// (>= the 50ms per-check threshold); total stays at 70ms (< 2000ms),
			// so the per-check branch fires but the total-summary branch does not.
			const firstCheck = getSuggestionChecks()[0]?.check;
			const writes = runWithScriptedTiming(new Map([[0, 70]]), "const x = 1;\n", "/tmp/slow1.ts");

			const perCheckLines = writes.filter((w) => w.includes("took"));
			expect(perCheckLines).toHaveLength(1);
			expect(perCheckLines[0]).toContain(`${firstCheck} took 70ms on /tmp/slow1.ts`);
			// Total-summary branch must NOT have fired (70ms < 2000ms threshold).
			expect(writes.some((w) => w.includes("total="))).toBe(false);
		});

		it("does not log when every check is under the per-check threshold and total is small", () => {
			// 40ms is below the 50ms per-check threshold; one slow-ish check, tiny total.
			const writes = runWithScriptedTiming(new Map([[0, 40]]));
			expect(writes).toHaveLength(0);
		});

		it("logs the total-summary line with the top-3 offenders when the pass total crosses the threshold", () => {
			// Three checks with descending deltas summing to 2400ms (>= 2000ms),
			// every other check instantaneous. Drives BOTH the per-check branch
			// (each of the three exceeds 50ms) and the total branch, and exercises
			// the sort/slice/map/join that build the top-offenders summary.
			const checks = getSuggestionChecks().map((c) => c.check);
			const writes = runWithScriptedTiming(
				new Map([
					[0, 900],
					[1, 800],
					[2, 700],
				]),
				"const x = 1;\n",
				"/tmp/slowtotal.ts",
			);

			const summary = writes.find((w) => w.includes("total="));
			expect(summary).toBeDefined();
			expect(summary).toContain("total=2400ms");
			expect(summary).toContain("on /tmp/slowtotal.ts");
			// Top-3, descending by ms, in the canonical registry order for ties-free deltas.
			expect(summary).toContain(
				`top: ${checks[0]}=900ms, ${checks[1]}=800ms, ${checks[2]}=700ms`,
			);
			// A 4th-slowest check (none here) must not appear in the truncated top list.
			expect(summary).not.toContain("=600ms");
		});

		it("caps the total-summary offender list at three even when more checks are slow", () => {
			// Five slow checks; the summary must list exactly the top three by ms.
			const checks = getSuggestionChecks().map((c) => c.check);
			const writes = runWithScriptedTiming(
				new Map([
					[0, 500],
					[1, 600],
					[2, 700],
					[3, 800],
					[4, 900],
				]),
				"const x = 1;\n",
				"/tmp/slowmany.ts",
			);

			const summary = writes.find((w) => w.includes("total="));
			expect(summary).toBeDefined();
			// Total = 500+600+700+800+900 = 3500.
			expect(summary).toContain("total=3500ms");
			// Top three are indices 4 (900), 3 (800), 2 (700) — descending.
			expect(summary).toContain(`top: ${checks[4]}=900ms, ${checks[3]}=800ms, ${checks[2]}=700ms`);
			// The two slower-but-not-top entries are excluded from the summary line.
			expect(summary).not.toContain(`${checks[1]}=600ms`);
			expect(summary).not.toContain(`${checks[0]}=500ms`);
			// Exactly three "<name>=<ms>ms" tokens between "top: " and " on ".
			const topSegment = (summary ?? "").split("top: ")[1]?.split(" on ")[0] ?? "";
			expect(topSegment.split(", ")).toHaveLength(3);
		});
	});
});

describe("getSuggestionChecks", () => {
	it("returns a non-empty registry", () => {
		const checks = getSuggestionChecks();
		expect(checks.length).toBeGreaterThan(20);
	});

	it("every entry has check and source strings", () => {
		for (const c of getSuggestionChecks()) {
			expect(typeof c.check).toBe("string");
			expect(c.check.length).toBeGreaterThan(0);
			expect(typeof c.source).toBe("string");
		}
	});

	it("includes core categories of checks", () => {
		const ids = getSuggestionChecks().map((c) => c.check);
		expect(ids).toContain("sql-injection");
		expect(ids).toContain("boolean-trap");
		expect(ids).toContain("magic-numbers");
		expect(ids).toContain("perf-await-in-loop");
	});

	it("only uses the three declared source categories", () => {
		const allowed = new Set(["security", "performance", "quality"]);
		for (const c of getSuggestionChecks()) {
			expect(allowed.has(c.source)).toBe(true);
		}
	});

	it("returns a defensive clone — mutating the result does not affect the registry", () => {
		const first = getSuggestionChecks();
		const originalLength = first.length;
		nonNull(first[0]).check = "tampered";
		// A fresh call must be unaffected by the mutation above.
		const second = getSuggestionChecks();
		expect(second).toHaveLength(originalLength);
		expect(second.some((c) => c.check === "tampered")).toBe(false);
		expect(second[0]?.check).toBe("sql-injection");
	});
});
