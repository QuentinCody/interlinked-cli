import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareFindingBundle, parseFindingBundle } from "./finding-evidence.js";
import { digest } from "./store.js";

const roots: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "finding-evidence-")); roots.push(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = (file = "source.ts", family = "cast_soundness") => ({ cases: [{ id: "case-1", family, origin: "detector", claim: "The assertion is unsupported", sources: [{ id: "source", file, purpose: "implementation", startLine: 1, endLine: 1 }], missing: [] }] });

describe("frozen finding evidence", () => {
	it("captures a named function instead of trusting manually counted line ranges", () => {
		const root = temp(); writeFileSync(join(root, "source.ts"), "const unrelated = 1;\nexport function wrap() {\n return work();\n}\n");
		const value = { cases: [{ ...plan().cases[0], sources: [{ id: "function", file: "source.ts", purpose: "complete function", symbol: "wrap" }] }] };
		const bundle = prepareFindingBundle(root, value);
		expect(bundle.packets[0]?.evidence[0]).toMatchObject({ startLine: 2, endLine: 4, text: "export function wrap() {\n return work();\n}" });
		value.cases[0]!.sources[0]!.symbol = "missing";
		expect(prepareFindingBundle(root, value).packets[0]?.missing[0]).toContain("symbol unavailable or ambiguous");
	});
	it("includes adjacent documentation for a named declaration while excluding separated headers and sibling trailing comments", () => {
		const root = temp();
		const text = "// File overview\n\nconst previous = 1; // About previous\n/** Returns the original promise. */\n// Keeps rejection visible to callers.\nexport const wrap = () => work();\n";
		writeFileSync(join(root, "source.ts"), text);
		const value = { cases: [{ ...plan().cases[0], family: "documentation", sources: [{ id: "function", file: "source.ts", purpose: "name, adjacent comments and implementation", symbol: "wrap" }] }] };
		const captured = prepareFindingBundle(root, value).packets[0]!.evidence[0]!;
		expect(captured).toMatchObject({ startLine: 4, endLine: 6, text: "/** Returns the original promise. */\n// Keeps rejection visible to callers.\nexport const wrap = () => work();" });
		writeFileSync(join(root, "source.ts"), "// Separated file overview\n\nexport function wrap() { return work(); }\n");
		expect(prepareFindingBundle(root, value).packets[0]!.evidence[0]).toMatchObject({ startLine: 3, text: "export function wrap() { return work(); }" });
	});
	it("enforces evidence bounds even when an oversized imported artifact has correct hashes", () => {
		const root = temp(); writeFileSync(join(root, "source.ts"), "source");
		const bundle = prepareFindingBundle(root, plan()), packet = bundle.packets[0]!;
		packet.evidence[0]!.text = "x".repeat(48_001);
		const { id: _packetId, ...packetBody } = packet; packet.id = digest(packetBody);
		const { id: _bundleId, ...bundleBody } = bundle; bundle.id = digest(bundleBody);
		expect(() => parseFindingBundle(bundle)).toThrow("budget");
	});
	it("binds the reviewed span and source bytes without depending on later edits", () => {
		const root = temp(); writeFileSync(join(root, "source.ts"), "const n = input as number;\nother();\n");
		const bundle = prepareFindingBundle(root, plan());
		expect(bundle.packets[0]?.evidence[0]?.text).toBe("const n = input as number;");
		expect(parseFindingBundle(bundle)).toEqual(bundle);
		writeFileSync(join(root, "source.ts"), "different();");
		expect(prepareFindingBundle(root, plan()).id).not.toBe(bundle.id);
		const changed = structuredClone(bundle); changed.packets[0]!.claim = "changed";
		expect(() => parseFindingBundle(changed)).toThrow("identity");
		const frozenDiscovery = { cases: [{ ...plan().cases[0], sources: [{ ...plan().cases[0]!.sources[0], expectedHash: bundle.packets[0]!.evidence[0]!.sourceHash }] }] };
		expect(prepareFindingBundle(root, frozenDiscovery).packets[0]?.missing[0]).toContain("source changed since discovery");
	});
	it("retains unavailable context and missing adopted policy rather than claiming a clean review", () => {
		const bundle = prepareFindingBundle(temp(), plan("absent.ts", "core_effect"));
		expect(bundle.packets[0]?.missing).toEqual(expect.arrayContaining(["adopted policy unavailable", expect.stringContaining("source: unavailable")]));
		expect(bundle.packets[0]?.evidence).toEqual([]);
	});
	it("rejects traversal, external symlinks, duplicate identities and invalid source ranges", () => {
		const root = temp(), outside = temp(); writeFileSync(join(outside, "source.ts"), "secret");
		symlinkSync(join(outside, "source.ts"), join(root, "link.ts"));
		expect(() => prepareFindingBundle(root, plan("../outside.ts"))).toThrow("confined");
		expect(() => prepareFindingBundle(root, plan("link.ts"))).toThrow("confined");
		const duplicate = plan(); duplicate.cases.push(duplicate.cases[0]!);
		expect(() => prepareFindingBundle(root, duplicate)).toThrow("Duplicate");
		const invalid = plan(); invalid.cases[0]!.sources[0]!.startLine = 0;
		expect(() => prepareFindingBundle(root, invalid)).toThrow("range");
	});
});
