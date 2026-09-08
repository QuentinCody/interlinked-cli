import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract, metadata } from "./module-extractor.js";

describe("module-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mod-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exposes the expected metadata", () => {
		expect(metadata.name).toBe("module-extractor");
		expect(metadata.output_kinds).toContain("module");
		expect(metadata.supported_patterns.length).toBeGreaterThan(0);
	});

	it("discovers source files across supported extensions", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "a.ts"), "export const x = 1;");
		writeFileSync(join(tmp, "src", "b.py"), "x = 1");
		writeFileSync(join(tmp, "src", "c.rs"), "fn main() {}");
		writeFileSync(join(tmp, "src", "d.md"), "# not source");

		const { nodes, edges } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["src/a.ts", "src/b.py", "src/c.rs"].sort());
		expect(edges).toEqual([]);
	});

	it("skips node_modules / dist / .git directories", () => {
		mkdirSync(join(tmp, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "lib", "a.ts"), "");
		mkdirSync(join(tmp, "dist"));
		writeFileSync(join(tmp, "dist", "a.ts"), "");
		mkdirSync(join(tmp, ".git"));
		writeFileSync(join(tmp, "src.ts"), "");

		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label.includes("node_modules"))).toBe(false);
		expect(nodes.some((n) => n.label.includes("dist/"))).toBe(false);
		expect(nodes.some((n) => n.label === "src.ts")).toBe(true);
	});

	it("labels every node as kind=module + determinism_ceiling=partially_deterministic", () => {
		writeFileSync(join(tmp, "x.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes.map((node) => node.label)).toEqual(["x.ts"]);
		for (const n of nodes) {
			expect(n.kind).toBe("module");
			expect(n.determinism_ceiling).toBe("partially_deterministic");
			expect(n.provenance).toBe("extracted");
		}
	});

	it("returns empty nodes for an empty directory", () => {
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	it("honors .gitignore — a gitignored directory is not walked", () => {
		// The defense that stops the daemon OOM-ing on large monorepos: a
		// project's own heavy non-source trees (gitignored model weights, build
		// output under a custom name) are pruned via `git ls-files`, not a
		// hardcoded basename. Needs a real working tree — no commit required,
		// `--others --ignored` reads the index-free working state.
		execFileSync("git", ["init", "-q"], { cwd: tmp });
		writeFileSync(join(tmp, ".gitignore"), "ignored-data/\n");
		mkdirSync(join(tmp, "ignored-data"), { recursive: true });
		writeFileSync(join(tmp, "ignored-data", "weights.ts"), "export const w = 1;");
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "real.ts"), "export const r = 1;");

		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === "src/real.ts")).toBe(true);
		expect(nodes.some((n) => n.label.includes("ignored-data"))).toBe(false);
	});
});
