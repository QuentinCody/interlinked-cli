import { describe, expect, it } from "vitest";
import { renderAggregate, renderFooter, renderRows } from "./render.js";
import type { AggregateRow } from "./aggregate.js";
import type { TailScanStats } from "./reverse-reader.js";

// Strip ANSI escape sequences so assertions are stable regardless of
// whether the terminal-color path is active in this test environment.
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9]+m/g, "");
}

function cellPart(line: string): string {
	// text after the timestamp + its two-space separator
	const parts = strip(line).split("  ");
	return parts.slice(1).join("  ");
}

function baseStats(overrides: Partial<TailScanStats> = {}): TailScanStats {
	return {
		fileBytes: 1000,
		bytesScanned: 1000,
		recordsParsed: 5,
		malformedLines: 0,
		truncated: false,
		...overrides,
	};
}

describe("renderRows — positive (must fire)", () => {
	// test-contract: public-api — renderRows row header contract (typeof record.ts === "string" guard)
	it("renders '--' when record.ts is not a string (undefined)", () => {
		const out = renderRows([{}], ["ts"], false);
		expect(strip(out[0] ?? "")).toContain("--");
	});

	// test-contract: public-api — renderRows row header contract (typeof record.ts === "string" guard)
	it("formats record.ts via shortTimestamp when it IS a string", () => {
		const iso = "2026-08-22T10:00:00.000Z";
		const out = renderRows([{ ts: iso }], [], false);
		// shortTimestamp of a real ISO string must not be the raw fallback "--"
		expect(strip(out[0] ?? "")).not.toContain("--");
	});

	// test-contract: public-api — renderRows joins ts and cells with the literal two-space separator
	it("joins ts and cell with exactly two spaces, and cells with two spaces", () => {
		const out = renderRows([{ ts: "2026-08-22T10:00:00.000Z", a: "x", b: "y" }], ["a", "b"], false);
		const line = out[0] ?? "";
		const stripped = strip(line);
		const tsEnd = stripped.indexOf("  ");
		expect(tsEnd).toBeGreaterThan(0);
		expect(stripped).toContain("x  y");
	});
});

describe("renderCell (via renderRows) — positive (must fire)", () => {
	// test-contract: public-api — renderCell joins multi-value fields with a literal comma
	it("joins multiple values for a field with a comma", () => {
		// a dotted path that resolves to multiple leaf values exercises getPath's
		// array-flattening, giving renderCell more than one value to join
		const record = { items: [{ v: "a" }, { v: "b" }, { v: "c" }] };
		const out = renderRows([record], ["items.v"], false);
		expect(cellPart(out[0] ?? "")).toBe("a,b,c");
	});

	// test-contract: boundary — renderCell truncation slices to CELL_MAX_CHARS - 1 then appends the ellipsis
	it("truncates with ellipsis exactly at CELL_MAX_CHARS - 1 when over the limit and not full", () => {
		const long = "x".repeat(200);
		const record = { field: long };
		const out = renderRows([record], ["field"], false);
		const cell = cellPart(out[0] ?? "");
		expect(cell.endsWith("…")).toBe(true);
		expect(cell.length).toBe(120);
		expect(cell.slice(0, -1)).toBe("x".repeat(119));
	});

	// test-contract: boundary — renderCell truncation trigger is strictly '>' CELL_MAX_CHARS, not '>='
	it("does NOT truncate a cell exactly at CELL_MAX_CHARS (120) — boundary must be strictly '>'", () => {
		const exact = "x".repeat(120);
		const record = { field: exact };
		const out = renderRows([record], ["field"], false);
		const cell = cellPart(out[0] ?? "");
		expect(cell).toBe(exact);
		expect(cell.includes("…")).toBe(false);
	});

	// test-contract: public-api — renderRows `full` flag disables truncation entirely
	it("does not truncate at all when `full` is true, even far past the limit", () => {
		const long = "x".repeat(500);
		const record = { field: long };
		const out = renderRows([record], ["field"], true);
		expect(cellPart(out[0] ?? "")).toBe(long);
	});
});

describe("sanitizeCell (via renderRows) — positive (must fire)", () => {
	// test-contract: invariant — sanitizeCell must not inject any literal text into ordinary output
	it("produces exactly the flattened text with no injected placeholder content", () => {
		const record = { field: "hello world" };
		const out = renderRows([record], ["field"], false);
		const cell = cellPart(out[0] ?? "");
		expect(cell).toBe("hello world");
		expect(cell).not.toContain("Stryker was here!");
	});

	// test-contract: invariant — sanitizeCell flattens control bytes (newline) to a single row
	it("collapses a control byte (newline) into a single space, not left as-is", () => {
		const record = { field: "line1\nline2" };
		const out = renderRows([record], ["field"], false);
		const cell = cellPart(out[0] ?? "");
		expect(cell).toBe("line1 line2");
		expect(cell).not.toContain("\n");
	});

	// test-contract: boundary — DELETE_CODEPOINT (0x7f) is treated as a control byte
	it("flattens the DEL codepoint (0x7f) to a space", () => {
		const record = { field: `a${String.fromCharCode(0x7f)}b` };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe("a b");
	});

	// test-contract: boundary — CONTROL_MAX (0x20) is exclusive: the plain space itself is not a control byte
	it("treats a plain space (0x20) as ordinary text, not a control byte to flatten", () => {
		const record = { field: "a b" };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe("a b");
	});

	// test-contract: boundary — 0x1f (just below CONTROL_MAX) is still a control byte
	it("flattens the char just below CONTROL_MAX (0x1f)", () => {
		const record = { field: `a${String.fromCharCode(0x1f)}b` };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe("a b");
	});

	// test-contract: invariant — consecutive flattened-to-space control bytes collapse to one space
	it("collapses consecutive control/space runs into a single space", () => {
		const record = { field: "a\n\n\nb" };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe("a b");
	});

	// test-contract: invariant — ordinary adjacent non-space characters are never collapsed
	it("does not collapse two adjacent ordinary (non-control) characters", () => {
		const record = { field: "ab" };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe("ab");
	});

	// test-contract: boundary — lastWasSpace must initialize false so a leading control byte still emits a space
	it("preserves a leading control-turned-space instead of dropping it (lastWasSpace must start false)", () => {
		const record = { field: "\nabc" };
		const out = renderRows([record], ["field"], false);
		expect(cellPart(out[0] ?? "")).toBe(" abc");
	});
});

describe("renderAggregate — positive (must fire)", () => {
	const rows: AggregateRow[] = [
		{ key: "a", count: 3 },
		{ key: "b", count: 5, sum: 10 },
	];

	// test-contract: public-api — hasSum uses .some(), so one row with a sum enables the sum column for ALL rows
	it("includes a sum column when at least one row has sum !== undefined (some, not every)", () => {
		const out = renderAggregate(rows);
		const stripped0 = strip(out[0] ?? "");
		const stripped1 = strip(out[1] ?? "");
		// sum column present for both rows once hasSum is true (row a defaults to 0)
		expect(stripped0).toMatch(/0\s*a$/);
		expect(stripped1).toMatch(/10\s*b$/);
	});

	// test-contract: public-api — hasSum is false, so no numeric sum column is rendered at all
	it("omits the sum column entirely when NO row has a sum", () => {
		const out = renderAggregate([{ key: "x", count: 1 }]);
		const stripped = strip(out[0] ?? "");
		expect(stripped).toBe(`${"1".padStart(7)}  x`);
	});
});

describe("renderFooter — positive (must fire)", () => {
	// test-contract: public-api — renderFooter's MB figure is bytesScanned / (1024*1024), a division not a multiplication
	it("computes MB as bytesScanned / (1024*1024), not multiplied", () => {
		const stats = baseStats({ bytesScanned: 2 * 1024 * 1024 });
		const out = strip(renderFooter(stats, "test.jsonl", {}));
		expect(out).toContain("2.0 MB");
	});

	// test-contract: public-api — a small byte count must stay small in MB, catching an arithmetic-operator flip
	it("does not produce an absurdly large MB value for a small byte count", () => {
		const stats = baseStats({ bytesScanned: 500 });
		const out = strip(renderFooter(stats, "test.jsonl", {}));
		expect(out).toContain("0.0 MB");
	});

	// test-contract: public-api — the malformed-lines suffix defaults to "" (not a placeholder) when there are none
	it("does not append 'malformed lines skipped' or placeholder text when malformedLines is 0", () => {
		const stats = baseStats({ malformedLines: 0 });
		const out = strip(renderFooter(stats, "test.jsonl", {}));
		expect(out).not.toContain("malformed");
		expect(out).not.toContain("Stryker was here!");
	});

	// test-contract: public-api — malformedLines > 0 must append the visible suffix
	it("appends malformed-lines suffix when malformedLines > 0", () => {
		const stats = baseStats({ malformedLines: 3 });
		const out = strip(renderFooter(stats, "test.jsonl", {}));
		expect(out).toContain("3 malformed lines skipped");
	});
});
