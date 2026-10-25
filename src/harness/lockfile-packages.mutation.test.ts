import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeEvidenceOnDisk, parseLockfilePackages } from "./lockfile-packages.js";

// Basis for the assertions below: the module header (lockfile-packages.ts:13-15)
// says parsers must never invent or hide a package, and the doc comments at
// :88-89 (package-lock shapes), :133-136 (pnpm), :188-190 (yarn), :228 (bun) and
// :326-328 (on-disk evidence) state the shapes each parser accepts.

describe("package-lock — mutation hardening", () => {
	it("a v2 lockfile that carries both `packages` and `dependencies` is read from `packages` only", () => {
		const lock = JSON.stringify({
			lockfileVersion: 2,
			packages: { "": {}, "node_modules/from-packages": { version: "1.0.0" } },
			dependencies: { "from-legacy-tree": { version: "9.9.9" } },
		});
		const inv = parseLockfilePackages("package-lock.json", lock);
		expect([...inv!.keys()]).toEqual(["from-packages"]);
	});

	it("a bare `node_modules/` key does not invent a package with an empty name", () => {
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/": { version: "1.0.0" }, "node_modules/real": { version: "1.0.0" } },
		});
		const inv = parseLockfilePackages("package-lock.json", lock);
		expect([...inv!.keys()]).toEqual(["real"]);
	});

	it("a non-object `packages` entry is skipped instead of crashing or becoming a package", () => {
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/null-entry": null, "node_modules/string-entry": "1.0.0", "node_modules/ok": { version: "2.0.0" } },
		});
		let inv: ReturnType<typeof parseLockfilePackages> = null;
		expect(() => {
			inv = parseLockfilePackages("package-lock.json", lock);
		}).not.toThrow();
		expect([...inv!.keys()]).toEqual(["ok"]);
	});

	it("native evidence from every node_modules location of the same package name is merged into one entry", () => {
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"node_modules/dup": { version: "1.0.0" },
				"node_modules/host/node_modules/dup": { version: "2.0.0", hasInstallScript: true },
			},
		});
		const inv = parseLockfilePackages("package-lock.json", lock)!;
		expect(inv.size).toBe(1);
		expect(inv.get("dup")?.native).toContain("install script");
	});

	it("an entry that constrains only cpu, or only os, is still platform evidence", () => {
		const lock = JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"node_modules/cpu-only": { version: "1.0.0", cpu: ["arm64"] },
				"node_modules/os-only": { version: "1.0.0", os: ["darwin"] },
			},
		});
		const inv = parseLockfilePackages("package-lock.json", lock)!;
		expect(inv.get("cpu-only")?.native.some((n) => n.startsWith("platform package"))).toBe(true);
		expect(inv.get("os-only")?.native.some((n) => n.startsWith("platform package"))).toBe(true);
	});

	it("npm-shrinkwrap.json is parsed with the package-lock grammar", () => {
		const lock = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } });
		expect(parseLockfilePackages("npm-shrinkwrap.json", lock)?.get("a")?.version).toBe("1.0.0");
	});
});

describe("pnpm-lock — mutation hardening", () => {
	it("a v6 key with a leading slash (`/name@version:`) names the package without the slash", () => {
		const pnpm = ["lockfileVersion: '6.0'", "", "packages:", "", "  /left-pad@1.3.0:", "    resolution: {integrity: sha512-a}"].join("\n");
		const inv = parseLockfilePackages("pnpm-lock.yaml", pnpm)!;
		expect(inv.get("left-pad")).toMatchObject({ name: "left-pad", version: "1.3.0" });
	});

	it("`requiresBuild: false` and `optional: false` are not native evidence", () => {
		const pnpm = [
			"packages:",
			"",
			"  quiet@1.0.0:",
			"    requiresBuild: false",
			"    optional: false",
		].join("\n");
		expect(parseLockfilePackages("pnpm-lock.yaml", pnpm)!.get("quiet")?.native).toEqual([]);
	});

	it("`requiresBuild: true` with trailing whitespace is still the install-script marker", () => {
		const pnpm = ["packages:", "", "  builder@1.0.0:", "    requiresBuild: true   "].join("\n");
		expect(parseLockfilePackages("pnpm-lock.yaml", pnpm)!.get("builder")?.native).toContain("install script");
	});

	it("a field line that opens a new section before any key does not attach to the previous section's last package", () => {
		const pnpm = ["packages:", "", "  plain@1.0.0:", "    resolution: {integrity: sha512-a}", "", "snapshots:", "    optional: true"].join("\n");
		expect(parseLockfilePackages("pnpm-lock.yaml", pnpm)!.get("plain")?.native).toEqual([]);
	});
});

describe("yarn.lock — mutation hardening", () => {
	it("a scoped descriptor with no range keeps its scoped name (the only `@` is the scope marker)", () => {
		const yarn = ["# yarn lockfile v1", "", "@scope/pkg:", '  version "1.0.0"'].join("\n");
		expect(parseLockfilePackages("yarn.lock", yarn)!.get("@scope/pkg")?.version).toBe("1.0.0");
	});
});

describe("bun.lock — mutation hardening", () => {
	it("whole-line `//` comments in the JSONC file are ignored", () => {
		const bun = ["// bun lockfile", "{", '  "packages": {', '    "a": ["a@1.0.0", "", {}, "sha512-x"],', "  },", "}"].join("\n");
		expect(parseLockfilePackages("bun.lock", bun)?.get("a")?.version).toBe("1.0.0");
	});

	it("a spec for a different package that merely starts with the key's name yields no version", () => {
		const bun = JSON.stringify({ packages: { foo: ["foobar@1.0.0", "", {}, "sha512-x"] } });
		expect(parseLockfilePackages("bun.lock", bun)?.get("foo")?.version).toBeNull();
	});
});

describe("nativeEvidenceOnDisk — mutation hardening", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lockfile-packages-mut-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("a postinstall script alone is install-phase evidence", () => {
		const pkg = join(dir, "node_modules", "post");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ scripts: { postinstall: "node x.js" } }));
		expect(nativeEvidenceOnDisk(dir, "post")).toEqual(["install script (postinstall)"]);
	});

	it("a preinstall script alone is install-phase evidence", () => {
		const pkg = join(dir, "node_modules", "pre");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ scripts: { preinstall: "node x.js" } }));
		expect(nativeEvidenceOnDisk(dir, "pre")).toEqual(["install script (preinstall)"]);
	});

	it("a `.node` file at the package top level is a native binary", () => {
		const pkg = join(dir, "node_modules", "top");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "addon.node"), "");
		expect(nativeEvidenceOnDisk(dir, "top")).toEqual([".node binary"]);
	});
});
