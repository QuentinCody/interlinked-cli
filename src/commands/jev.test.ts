import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../harness/jev/client.js";
import { jevDocClaimsAction, jevTestTitlesAction, resolveImportersIn } from "./jev.js";

let dir = "";
const out: string[] = [];
const err: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jev-cmd-"));
	out.length = 0;
	err.length = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		err.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function noulClient(value: number, verdict = "mismatch"): JevClient {
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string }> }; // SAFETY: the client serializes exactly this shape
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(body.questions)) {
			answers[id] = q.type === "choice" ? { type: "choice", choice: verdict, probabilities: { mismatch: 1 }, confidence: 0.9 } : { type: "noul", noul: value };
		}
		return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
	});
	return new JevClient({ apiKey: "k", fetchImpl });
}

describe("jevTestTitlesAction", () => {
	it("P1: prints one finding line per flagged block and exits 0", async () => {
		const file = join(dir, "x.test.ts");
		writeFileSync(file, `it("returns null", () => {\n\texpect(f()).toBe(1);\n});\n`);
		const code = await jevTestTitlesAction([file], { client: noulClient(0.1) });
		expect(code).toBe(0);
		expect(out.join("")).toContain("[interlinked:jev-test-title]");
		expect(out.join("")).toContain("returns null");
	});
	it("N1: with Jev disabled (no client) it explains and exits 2 without scanning", async () => {
		const code = await jevTestTitlesAction([join(dir, "x.test.ts")], { client: null });
		expect(code).toBe(2);
		expect(err.join("")).toContain("jev.enabled");
	});
	it("N2: a clean file prints a summary line and no findings", async () => {
		const file = join(dir, "y.test.ts");
		writeFileSync(file, `it("adds", () => {\n\texpect(add(1, 1)).toBe(2);\n});\n`);
		await jevTestTitlesAction([file], { client: noulClient(0.95, "match") });
		expect(out.join("")).not.toContain("[interlinked:jev-test-title]");
		expect(out.join("")).toContain("0 finding");
	});
});

describe("resolveImportersIn", () => {
	it("P1: reports a missing file as not existing", () => {
		const resolve = resolveImportersIn(dir);
		expect(resolve("src/nope.ts")).toEqual({ exists: false, nonTestImporters: 0 });
	});
	it("P3: an entry point counts as imported even with no static importer", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
		expect(resolveImportersIn(dir)("src/index.ts")).toEqual({ exists: true, nonTestImporters: 1 });
	});
	it("P2: counts a non-test importer and ignores a test importer", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "leaf.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "src", "user.ts"), 'import { x } from "./leaf.js";\nexport const y = x;\n');
		writeFileSync(join(dir, "src", "leaf.test.ts"), 'import { x } from "./leaf.js";\n');
		const resolve = resolveImportersIn(dir);
		expect(resolve("src/leaf.ts")).toEqual({ exists: true, nonTestImporters: 1 });
	});
});

describe("jevDocClaimsAction", () => {
	it("P1: flags a live claim about a file nothing imports", async () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "orphan.ts"), "export const o = 1;\n");
		const doc = join(dir, "design.md");
		writeFileSync(doc, "The orphan gate now runs on every edit and is wired in src/orphan.ts; it blocks when crossed.\n");
		const code = await jevDocClaimsAction([doc], { client: noulClient(0.9), cwd: dir });
		expect(code).toBe(0);
		expect(out.join("")).toContain("[interlinked:jev-doc-claim]");
		expect(out.join("")).toContain("src/orphan.ts");
	});
	it("N1: no client → exit 2", async () => {
		expect(await jevDocClaimsAction([join(dir, "d.md")], { client: null, cwd: dir })).toBe(2);
	});
});
