// Mutation-kill companion for allowlist-verify.ts (fleet wave 31, pass1).
//
// Targets 37 of the 39 mutants recorded as "survived" for allowlist-verify.ts
// in .interlinked/mutation-manifest.json. Two are left still_open in the
// receipts (hand-traced, suspected equivalent — no killing test written, per
// the write-only contract):
//   - e4dd71298c2623b7 (readIfPresent: `!existsSync(path)` -> `false`): every
//     call site passes a path just enumerated by findManifestFiles's real
//     directory walk, so the file always exists at call time; skipping the
//     early-return just falls through to the same try/catch that already
//     returns null on any read failure.
//   - bf458f6502af686f (reportUnapproved: `"registry"` -> `""`): isPackageAllowed
//     only special-cases `spec.kind` "git_url" / "tarball_url" / "file_url" /
//     "local_path" — any other value (including "") falls through to the same
//     default registry-lookup branch.
//
// `node:fs` is partially mocked (vi.hoisted spy delegating to the real
// implementation by default) so a handful of mutants that only manifest when
// a file read fails after existsSync already reported the file present can be
// exercised without relying on real permission bits (root-run CI would make
// chmod-based flakiness untestable).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToAllowlist } from "../harness/package-allowlist.js";
import { verifyAllowlistCommand } from "./allowlist-verify.js";

const { readFileSyncSpy, actualRef } = vi.hoisted(() => {
	const actualRef: { fn: typeof import("node:fs").readFileSync } = {
		fn: () => { throw new Error("readFileSync has not been initialized"); },
	};
	return { readFileSyncSpy: vi.fn(), actualRef };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	actualRef.fn = actual.readFileSync;
	readFileSyncSpy.mockImplementation(actual.readFileSync);
	return { ...actual, readFileSync: readFileSyncSpy };
});

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-verify-w31-"));
	process.exitCode = undefined;
	readFileSyncSpy.mockImplementation(actualRef.fn);
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	process.exitCode = undefined;
	readFileSyncSpy.mockImplementation(actualRef.fn);
});

function capture(fn: () => void): string {
	let out = "";
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array): boolean => {
			out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	try {
		fn();
	} finally {
		spy.mockRestore();
	}
	return out;
}

describe("verifyAllowlistCommand — header text (mutation-kill)", () => {
	// test-contract: public-api — kills 3b369db5ca7b9e7e (StringLiteral
	// header template -> ``, which would print nothing before the issue list)
	it("prints the '<n> unapproved dep(s):' header before the issue list", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { "header-check-dep": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/1 unapproved dep\(s\):/);
		expect(process.exitCode).toBe(1);
	});
});

describe("reportUnapproved — full reason text survives (mutation-kill)", () => {
	// test-contract: public-api — kills ff6a9b1059732b72 (LogicalOperator
	// `decision.reason ?? "unapproved"` -> `decision.reason && "unapproved"`;
	// since decision.reason is always a truthy descriptive string on the
	// not-allowed path, `&&` collapses it to the literal "unapproved" instead)
	it("reports the specific allowlist reason, not a generic 'unapproved' fallback", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ dependencies: { "totally-unapproved-thing": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/is not in the npm allowlist/);
	});
});

describe("readManifestsByName — content===null guard (mutation-kill)", () => {
	// test-contract: invariant — kills
	// 505e2213323c907c (ConditionalExpression `content !== null` -> `true`,
	// which would push a null-content entry even when the read failed, and
	// JSON.parse(null) parses to JS `null` rather than throwing, so the
	// downstream `isJsonObject` check would then wrongly report "not a JSON
	// object" for a file whose read simply failed)
	it("skips a package.json whose read throws even though the file exists on disk", () => {
		const target = join(workspace, "package.json");
		writeFileSync(target, "{}");
		readFileSyncSpy.mockImplementation((...args: Parameters<typeof actualRef.fn>) => {
			const [path] = args;
			if (typeof path === "string" && path === target) {
				throw new Error("simulated read failure");
			}
			return actualRef.fn(...args);
		});
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkPackageJson — per-field isolation (mutation-kill)", () => {
	// test-contract: public-api — kills ac6d10aa262fea2d (StringLiteral
	// "devDependencies" -> "")
	it("flags an unapproved devDependencies-only entry", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ devDependencies: { "evil-dev-only": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-dev-only/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills 157f1025f0c14d63 (StringLiteral
	// "optionalDependencies" -> "")
	it("flags an unapproved optionalDependencies-only entry", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ optionalDependencies: { "evil-optional-only": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-optional-only/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills e056594d5c8f9529 (StringLiteral
	// "peerDependencies" -> "")
	it("flags an unapproved peerDependencies-only entry", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ peerDependencies: { "evil-peer-only": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-peer-only/);
		expect(process.exitCode).toBe(1);
	});
});

describe("checkRequirementsTxt — plain requirements.txt, LF-only, multi-line (mutation-kill)", () => {
	// test-contract: public-api — kills b69ae43ddbb6e679 (Regex /\r?\n/ ->
	// /\r\n/, which would fail to split LF-only content, collapsing both lines
	// into one and losing the second dep name entirely); e9bc486b09b95e10 and
	// e02c24582b45c3bc (both mutate the `n === "requirements.txt"` disjunct so
	// the file is never matched as requirements.txt at all); and
	// 6730f191c2f4a844 (StringLiteral "requirements.txt" -> "", same effect)
	it("flags BOTH unapproved deps from a two-line requirements.txt (not .in)", () => {
		writeFileSync(
			join(workspace, "requirements.txt"),
			"evil-pip-dep-one==1.0.0\nevil-pip-dep-two==2.0.0\n",
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-pip-dep-one/);
		expect(out).toMatch(/evil-pip-dep-two/);
		expect(process.exitCode).toBe(1);
	});
});

describe("checkRequirementsTxt — matchName scope (mutation-kill)", () => {
	// test-contract: boundary — kills d1f9da0cefe1aeca (ConditionalExpression
	// `n === "requirements.txt" || n === "requirements.in"` -> `true`, which
	// would treat every file in the tree as a pip requirements file)
	it("does NOT parse an unrelated file as a pip requirement", () => {
		writeFileSync(join(workspace, "notes-w31.txt"), "malicious-pip-pkg==1.0.0\n");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkExtracted — matchName scope (mutation-kill)", () => {
	// test-contract: boundary — kills 057794dadbe5661d (ConditionalExpression
	// `n === spec.file` -> `true`, which would run every extractor over every
	// file in the tree regardless of its actual basename)
	it("does NOT run the Cargo extractor over a file that isn't named Cargo.toml", () => {
		writeFileSync(
			join(workspace, "random-file-w31.txt"),
			'[dependencies]\nevilcargo-hidden = "1.0"\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkCsprojFiles — content===null guard (mutation-kill)", () => {
	// test-contract: invariant — kills
	// b2aa3f9a5cfca7af (ConditionalExpression `content === null` -> `false`,
	// which would call extractNugetDeps(null) and throw instead of skipping)
	it("skips a .csproj whose read throws even though the file exists on disk", () => {
		const target = join(workspace, "App.csproj");
		writeFileSync(
			target,
			'<Project><ItemGroup><PackageReference Include="Whatever" Version="1.0.0" /></ItemGroup></Project>',
		);
		readFileSyncSpy.mockImplementation((...args: Parameters<typeof actualRef.fn>) => {
			const [path] = args;
			if (typeof path === "string" && path === target) {
				throw new Error("simulated read failure");
			}
			return actualRef.fn(...args);
		});
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkCsprojFiles — matchName scope (mutation-kill)", () => {
	// test-contract: boundary — kills e489581a (StringLiteral ".csproj"
	// -> "", which makes `n.endsWith("")` true for every filename)
	it("does NOT run the nuget extractor over a non-.csproj file", () => {
		writeFileSync(
			join(workspace, "notpackages-w31.xml"),
			'<package id="Evil.NonCsproj" version="1.0.0" />',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkVersionCatalog — content===null guard (mutation-kill)", () => {
	// test-contract: invariant — kills
	// 365287848bebb7e8 (ConditionalExpression `content === null` -> `false`,
	// which would call extractGradleVersionCatalogDeps(null) and throw instead
	// of skipping)
	it("skips a libs.versions.toml whose read throws even though the file exists on disk", () => {
		const target = join(workspace, "libs.versions.toml");
		writeFileSync(target, '[libraries]\nwhatever = { module = "g:a", version = "1.0" }\n');
		readFileSyncSpy.mockImplementation((...args: Parameters<typeof actualRef.fn>) => {
			const [path] = args;
			if (typeof path === "string" && path === target) {
				throw new Error("simulated read failure");
			}
			return actualRef.fn(...args);
		});
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("checkVersionCatalog — matchName scope (mutation-kill)", () => {
	// test-contract: boundary — kills 4791c174d7129d28 (ConditionalExpression
	// `n === "libs.versions.toml"` -> `true`, which makes any filename a
	// candidate version-catalog)
	it("does NOT parse an unrelated .toml file as a Gradle version catalog", () => {
		writeFileSync(
			join(workspace, "other-w31.toml"),
			'[libraries]\nevilcat = { module = "com.evilcat:lib", version = "1.0.0" }\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("EXTRACTORS table — per-entry reachability (mutation-kill)", () => {
	// Each test below kills the 3 module-level mutants for its ecosystem entry:
	// the whole-object ObjectLiteral -> {} mutant, the `file` StringLiteral ->
	// "" mutant, and the `ecosystem` StringLiteral -> "" mutant. All three
	// break the same observable: with any of them active, the real manifest
	// file created here is either never matched (object/file mutants — the
	// extractor is never reached) or its finding is misfiled/crashes the
	// ecosystem lookup (ecosystem mutant — `al.packages[""]` is undefined).

	// test-contract: public-api — kills 206aa676e7a9afa1, 66702950e9a9199f,
	// 530ed639e185cdaa (pyproject.toml / pypi entry)
	it("flags an unapproved pyproject.toml dependency", () => {
		writeFileSync(
			join(workspace, "pyproject.toml"),
			'dependencies = [\n  "evil-pypkg-w31==1.0.0"\n]\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-pypkg-w31/);
		expect(out).toMatch(/pypi/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills 276aedafb20e6e89, ad0db89a92185767,
	// 129910c5413bae81 (Cargo.toml / cargo entry)
	it("flags an unapproved Cargo.toml dependency", () => {
		writeFileSync(
			join(workspace, "Cargo.toml"),
			'[dependencies]\nevil-crate-w31 = "1.0"\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-crate-w31/);
		expect(out).toMatch(/cargo/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills 4755989741abbfee, bd0ef5e9177bc7d1,
	// 1fe9e42d4ea2fd5e (Gemfile / rubygems entry)
	it("flags an unapproved Gemfile dependency", () => {
		writeFileSync(join(workspace, "Gemfile"), 'gem "evil-gem-w31"\n');
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-gem-w31/);
		expect(out).toMatch(/rubygems/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills a275627617f07146, 924c1e393115fb3d,
	// 1d66dd7900c1e278 (go.mod / go entry)
	it("flags an unapproved go.mod dependency", () => {
		writeFileSync(
			join(workspace, "go.mod"),
			"module example.com/thing\n\nrequire (\n\tgithub.com/evil/w31pkg v1.0.0\n)\n",
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/github\.com\/evil\/w31pkg/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills 4166ab6e17268144, a449f334cd33142b,
	// d3dd1a0c5375b0ba (composer.json / composer entry)
	it("flags an unapproved composer.json dependency", () => {
		writeFileSync(
			join(workspace, "composer.json"),
			JSON.stringify({ require: { "evil/composer-w31": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil\/composer-w31/);
		expect(out).toMatch(/composer/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills cd59b0fe32150bd8, fe77658c11071f96,
	// 3c1ec8fa05139514 (build.gradle.kts / gradle entry)
	it("flags an unapproved build.gradle.kts dependency", () => {
		writeFileSync(
			join(workspace, "build.gradle.kts"),
			'dependencies {\n    implementation("com.evil:gradle-kts-w31:1.0.0")\n}\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:gradle-kts-w31/);
		expect(out).toMatch(/gradle/);
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — kills 3b896270e3e1b235, dcb310b8721990f5,
	// 68a650aba80e0b78 (packages.config / nuget entry)
	it("flags an unapproved packages.config dependency", () => {
		writeFileSync(
			join(workspace, "packages.config"),
			'<packages><package id="Evil.Nuget.W31" version="1.0.0" /></packages>',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/Evil\.Nuget\.W31/);
		expect(out).toMatch(/nuget/);
		expect(process.exitCode).toBe(1);
	});
});

describe("verifyAllowlistCommand — sanity: allowlisted deps stay clean (mutation-kill guard)", () => {
	// test-contract: public-api — sanity check for the tests above: an
	// allowlisted dep must NOT be reported, so the "flags an unapproved X"
	// assertions elsewhere in this file are actually discriminating and not
	// vacuously true regardless of allowlist state.
	it("stays clean when the extracted dep IS allowlisted", () => {
		addToAllowlist(workspace, "cargo", "already-fine-w31", { approved_by: "x" });
		writeFileSync(
			join(workspace, "Cargo.toml"),
			'[dependencies]\nalready-fine-w31 = "1.0"\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});
