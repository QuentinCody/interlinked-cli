import { describe, expect, it } from "vitest";
import { checkSingleUseTrivialHelper } from "./over-extraction.js";

// `checkSingleUseTrivialHelper` is the counterweight to the complexity caps:
// the caps push relentlessly toward extraction, and nothing pushed back. Every
// fixture below is passed as `content` to the SUT call in `run`, so each
// assertion is grounded in the detector's own behaviour.

function run(
	content: string,
	path = "src/lib/orders.ts",
): ReturnType<typeof checkSingleUseTrivialHelper> {
	return checkSingleUseTrivialHelper(content, path);
}

describe("checkSingleUseTrivialHelper — positive (must fire)", () => {
	it("P1: flags a 2-line private helper called once, named processItems", () => {
		const found = run(`
function processItems(items: number[]): number[] {
	const doubled = items.map((n) => n * 2);
	return doubled;
}

export function report(items: number[]): number[] {
	return processItems(items);
}
`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("processItems");
	});

	it("P2: flags a single-statement helper whose name merely restates the callee", () => {
		const found = run(`
function parseJson(raw: string): unknown {
	return JSON.parse(raw);
}

export function load(raw: string): unknown {
	return parseJson(raw);
}
`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("parseJson");
	});

	it("P3: flags a generic-shaped arrow helper assigned to a const", () => {
		const found = run(`
const buildResult = (n: number) => {
	return { n };
};

export function make(n: number): { n: number } {
	return buildResult(n);
}
`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("buildResult");
	});

	it("P4: reports the declaration line of the flagged helper", () => {
		const found = run(`export const x = 1;
function handleData(d: string): string {
	return d.trim();
}
export const y = handleData("a");
`);
		expect(found[0]?.line).toBe(2);
	});
});

describe("checkSingleUseTrivialHelper — negative (must not fire)", () => {
	it("N1: does not flag a helper called from three sites", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}

export function a(i: number[]): number[] { return processItems(i); }
export function b(i: number[]): number[] { return processItems(i); }
export function c(i: number[]): number[] { return processItems(i); }
`),
		).toHaveLength(0);
	});

	it("N2: does not flag an exported helper", () => {
		expect(
			run(`
export function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}

export function report(i: number[]): number[] { return processItems(i); }
`),
		).toHaveLength(0);
	});

	it("N3: does not flag a helper whose name states a domain rule the call site lacks", () => {
		expect(
			run(`
function isEligibleForRefund(order: { days: number; used: boolean }): boolean {
	return order.days <= 30 && !order.used;
}

export function refund(order: { days: number; used: boolean }): string {
	return isEligibleForRefund(order) ? "ok" : "no";
}
`),
		).toHaveLength(0);
	});

	it("N4: does not flag a long helper — extraction that genuinely reduced a big function", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	const out: number[] = [];
	for (const n of items) out.push(n * 2);
	const sorted = out.sort();
	const capped = sorted.slice(0, 10);
	return capped;
}

export function report(i: number[]): number[] { return processItems(i); }
`),
		).toHaveLength(0);
	});

	it("N5: does not flag a helper re-exported through an export list", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}

export { processItems };
`),
		).toHaveLength(0);
	});

	it("N6: does not flag a helper referenced as a value rather than called", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}

export const handler: (i: number[]) => number[] = processItems;
`),
		).toHaveLength(0);
	});

	it("N7: does not flag a specifically-named trivial helper", () => {
		expect(
			run(`
function normalizeIsoWeekStart(d: Date): Date {
	return new Date(d.getTime());
}

export function week(d: Date): Date { return normalizeIsoWeekStart(d); }
`),
		).toHaveLength(0);
	});

	it("N8: does not run on test files", () => {
		expect(
			run(
				`
function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}
it("x", () => { processItems([1]); });
`,
				"src/lib/orders.test.ts",
			),
		).toHaveLength(0);
	});

	it("N9: does not run on non-JS/TS files", () => {
		expect(run("function processItems(): void {}\nprocessItems();\n", "notes.md")).toHaveLength(0);
	});

	it("N10: does not flag a recursive helper (self-reference is not a call site)", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	return items.length === 0 ? [] : processItems(items.slice(1));
}
`),
		).toHaveLength(0);
	});

	it("N12: does not flag a wrapper whose name adds a qualifier the bare callee lacks", () => {
		// `.filter` / `.sort` are restated by construction, but "since" and
		// "for display" are exactly the information the call site does not have.
		expect(
			run(`
function applySinceFilter(events: number[], since: number): number[] {
	return events.filter((e) => e >= since);
}

export function recent(e: number[], s: number): number[] { return applySinceFilter(e, s); }
`),
		).toHaveLength(0);
	});

	it("N11: does not flag when the only match is a property with the same name", () => {
		expect(
			run(`
function processItems(items: number[]): number[] {
	return items.map((n) => n * 2);
}

export const api = { processItems: (i: number[]) => i };
`),
		).toHaveLength(0);
	});
});
