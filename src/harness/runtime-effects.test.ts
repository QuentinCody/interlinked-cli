import { describe, expect, it } from "vitest";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { fileEffects } from "./runtime-effects.js";

function effects(source: string, path = "subject.test.ts") {
    const parsed = parseTsSource(source, path);
    if (!parsed) throw new Error("typescript is expected in this checkout");
    return fileEffects(parsed);
}

describe("fileEffects — positive (must fire): reads the repository bytes cannot vouch for are OPAQUE", () => {
    // test-contract: invariant — a file is opaque when executing it may read inputs the identity does not hash: a filesystem READ, a process/network/VM builtin, a package (its code may read files it is handed), dynamic loading, eval, the network, or a computed global access
    it.each([
        ['import { readFileSync } from "node:fs"; readFileSync("x");', "fs read: readFileSync"],
        ['import { existsSync } from "fs"; existsSync("x");', "fs read: existsSync"],
        ['import * as fs from "node:fs"; fs.writeFileSync("x", "");', "fs read: namespace"],
        ['import fs from "node:fs";', "fs read: namespace"],
        ['import { readFile } from "node:fs/promises";', "fs read: readFile"],
        ['import { execFileSync } from "node:child_process";', "builtin: child_process"],
        ['import { createRequire } from "node:module";', "builtin: module"],
        ['import { Command } from "commander";', "package: commander"],
        ["await import(target);", "dynamic import"],
        ["require(name);", "dynamic require"],
        ['require.resolve("x");', "require.resolve"],
        ["eval(code);", "eval"],
        ["new Function(code)();", "Function constructor"],
        ["await fetch(url);", "network: fetch"],
        ["new WebSocket(url);", "network: WebSocket"],
        ['global["fetch"](url);', "computed global access"],
        ["vi.importActual(target);", "vi.importActual non-literal"],
        ["process.stdin.read();", "process.stdin"],
        ['const files = import.meta.glob("./*.ts");', "import.meta.glob"],
    ])("%s → %s", (source, reason) => {
        expect(effects(source).opaque).toContain(reason);
    });
});

describe("fileEffects — positive (must fire): time, randomness and timers are NONDETERMINISTIC, not opaque", () => {
    // test-contract: invariant — the clock, randomness, timers and uninitialized memory make a result unrepeatable (never reused) without reading any repository input (no reason to rerun on an unrelated change)
    it.each([
        ["const now = new Date();", "Date"],
        ["Date.now();", "Date"],
        ["performance.now();", "performance"],
        ["Math.random();", "Math.random"],
        ["setTimeout(done, 5);", "timer: setTimeout"],
        ['import { randomUUID } from "node:crypto"; randomUUID();', "crypto: randomUUID"],
        ['import { setTimeout as delay } from "node:timers/promises";', "builtin: timers/promises"],
        ["Buffer.allocUnsafe(32)[0];", "Buffer.allocUnsafe"],
        ["process.hrtime.bigint();", "process.hrtime"],
    ])("%s → %s", (source, reason) => {
        const result = effects(source);
        expect(result.nondeterministic).toContain(reason);
        expect(result.opaque).toEqual([]);
    });
});

describe("fileEffects — negative (must not fire): hashed or pure reads are neither", () => {
    // test-contract: invariant — the environment is part of every check identity (environment hash), pure builtins compute only from their arguments, and filesystem WRITES produce outputs, not inputs; none of them is an unhashed input
    it.each([
        'process.env.HOME = "/tmp"; const flag = process.env.CI; process.platform;',
        'import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"; mkdtempSync("x");',
        'import { tmpdir, homedir } from "node:os"; tmpdir();',
        'import { join, dirname } from "node:path"; join("a", "b");',
        'import { createHash } from "node:crypto"; createHash("sha256");',
        'import { describe, it, expect, vi } from "vitest";',
        'import { value } from "./pure"; vi.mock("./pure"); await vi.importActual("./pure");',
        "function at(date: Date): string { return String(date); }",
        "const value = { Date: 1, random: 2 }; value.Date;",
    ])("%s", (source) => {
        expect(effects(source)).toMatchObject({ opaque: [], nondeterministic: [] });
    });
});

describe("fileEffects — review fixes — positive (must fire)", () => {
    // test-contract: invariant — loading a builtin through a vi loader, a network API reached by any value reference, the checkout path, an unlisted builtin member and fast-check are never pure
    it.each([
        ['await vi.importActual("node:fs");', "opaque", "fs read: namespace"],
        ['await vi.importMock("node:child_process");', "opaque", "builtin: child_process"],
        ['await vi.importActual("crypto");', "nondeterministic", "crypto: namespace"],
        ["await globalThis.fetch(url);", "opaque", "network: fetch"],
        ["const request = fetch; await request(url);", "opaque", "network: fetch"],
        ["new globalThis.WebSocket(url);", "opaque", "network: WebSocket"],
        ["const Socket = WebSocket; new Socket(url);", "opaque", "network: WebSocket"],
        ["const { fetch: f } = globalThis; f(url);", "opaque", "network: fetch"],
        ["new global.XMLHttpRequest();", "opaque", "network: XMLHttpRequest"],
        ["process.cwd();", "nondeterministic", "process.cwd"],
        ["const here = import.meta.url;", "nondeterministic", "import.meta.url"],
        ["const here = import.meta.dirname;", "nondeterministic", "import.meta.dirname"],
        ['import { uptime, freemem } from "node:os"; uptime();', "nondeterministic", "os: uptime"],
        ['import { hrtime } from "node:process"; hrtime();', "nondeterministic", "process: hrtime"],
        ['import * as os from "node:os"; os.uptime();', "nondeterministic", "os: uptime"],
        ['import { DatabaseSync } from "node:sqlite";', "opaque", "builtin: sqlite"],
        ['import { cwd } from "node:process"; cwd();', "nondeterministic", "process: cwd"],
        ['import fc from "fast-check"; fc.assert(fc.property(fc.nat(), n => n >= 0));', "nondeterministic", "package: fast-check"],
    ])("P: %s → %s %s", (source, kind, reason) => {
        expect(effects(source)[kind as "opaque" | "nondeterministic"]).toContain(reason);
    });
});

describe("fileEffects — review fixes — negative (must not fire): genuinely pure forms stay pure", () => {
    // test-contract: invariant — the review fixes do not make every form opaque
    it.each([
        'import { join } from "node:path"; import { fileURLToPath } from "node:url"; import { inspect } from "node:util"; join("a", "b");',
        'import { tmpdir, homedir, platform, EOL } from "node:os"; tmpdir(); platform();',
        'import { env, platform } from "node:process"; env.HOME; platform;',
        'import { createHash } from "node:crypto"; createHash("sha256");',
        'await vi.importActual("vitest");',
        "interface Api { fetch(): void } const x = { fetch: 1 }; x.fetch;",
        "const t: WebSocket | null = null;",
        'import { describe, it, expect, vi } from "vitest";',
    ])("N: %s", (source) => {
        expect(effects(source)).toMatchObject({ opaque: [], nondeterministic: [] });
    });
});

describe("fileEffects — round 2 — positive (must fire): every global or builtin reference is proven pure or non-reusable", () => {
    // test-contract: invariant — a member of a builtin that is not on the proven-pure list is never pure, whatever its module
    it.each([
        ['import { statfsSync } from "node:fs"; statfsSync("/");', "opaque", "fs read: statfsSync"],
        ['import { generateKeyPairSync } from "node:crypto"; generateKeyPairSync("rsa", { modulusLength: 512 });', "nondeterministic", "crypto: generateKeyPairSync"],
        ['import path from "node:path"; path.resolve("x");', "nondeterministic", "path: resolve"],
        ['import { relative } from "node:path";', "nondeterministic", "path: relative"],
        ['import * as p from "node:path"; p.resolve("x");', "nondeterministic", "path: resolve"],
        ['import * as p from "node:path"; const q = p; q.resolve("x");', "nondeterministic", "path: namespace"],
        ['import { pathToFileURL } from "node:url";', "nondeterministic", "url: pathToFileURL"],
        ['import { setTimeout as delay } from "node:timers/promises";', "nondeterministic", "builtin: timers/promises"],
    ])("builtin member %s → %s %s", (source, kind, reason) => {
        expect(effects(source)[kind as "opaque" | "nondeterministic"]).toContain(reason);
    });

    // test-contract: invariant — a global reached through a qualified, computed or aliased chain is judged by its root and member
    it.each([
        ["globalThis.Date.now();", "nondeterministic", "Date"],
        ["global.performance.now();", "nondeterministic", "performance"],
        ['Math["random"]();', "nondeterministic", "Math.random"],
        ["process.uptime();", "nondeterministic", "process.uptime"],
        ["globalThis.process.hrtime();", "nondeterministic", "process.hrtime"],
        ["globalThis.Buffer.allocUnsafe(8);", "nondeterministic", "Buffer.allocUnsafe"],
        ["const { random } = Math; random();", "nondeterministic", "Math: escape"],
        ["const m = Math; m.random();", "nondeterministic", "Math: escape"],
        ['const key = "random"; Math[key]();', "nondeterministic", "Math: computed"],
        ["process[key];", "nondeterministic", "process: computed"],
        ["const p = process; p.hrtime();", "nondeterministic", "process: escape"],
        ["globalThis.somethingSetBySetup;", "opaque", "globalThis.somethingSetBySetup"],
        ["globalThis;", "opaque", "global object escape"],
        ["const clock = Date; clock.now();", "nondeterministic", "Date"],
    ])("global chain %s → %s %s", (source, kind, reason) => {
        expect(effects(source)[kind as "opaque" | "nondeterministic"]).toContain(reason);
    });

    // test-contract: invariant — a vi loader that escapes as a value (aliased, passed, computed) can load anything, so it is opaque
    it.each([
        ['const load = vi.importActual; await load("./subject");', "vi.importActual"],
        ["run(vi.importMock);", "vi.importMock"],
        ["const mock = vi.doMock;", "vi.doMock"],
        ['const load = vi["importActual"];', "vi.importActual"],
        ["const helpers = vi; helpers.importActual(x);", "vi: escape"],
        ["vi.unknownHelper();", "vi.unknownHelper"],
    ])("vi escape %s → %s", (source, reason) => {
        expect(effects(source).opaque).toContain(reason);
    });
});

describe("fileEffects — round 2 — negative (must not fire): proven-pure forms stay pure", () => {
    // test-contract: invariant — the root rule is an allowlist, not "everything opaque"
    it.each([
        'import { join, basename, extname, dirname } from "node:path"; join("a", "b"); basename("a/b");',
        'import path from "node:path"; path.join("a", "b"); path.extname("x.ts"); path.sep;',
        'import * as path from "node:path"; path.dirname("a/b");',
        'import { createHash } from "node:crypto"; createHash("sha256");',
        'import crypto from "node:crypto"; crypto.createHash("sha256").update("x").digest("hex");',
        'import assert from "node:assert"; assert(true); assert.equal(1, 1);',
        "JSON.parse(\"{}\"); JSON.stringify({}); Math.max(1, 2); Math.floor(1.5); Array.from([1]); Object.keys({});",
        'vi.fn(); vi.spyOn(console, "log"); vi.useFakeTimers(); vi.setSystemTime(0);',
        'vi.mock("./x"); await vi.importActual("./x"); vi.doMock("./y");',
        'Buffer.from("x"); const isBuffer = (v: unknown) => v instanceof Buffer; Buffer.concat([]);',
        "process.env.X; process.platform; process.env[key];",
        "globalThis.structuredClone({}); globalThis.JSON.parse(\"1\"); globalThis.Math.max(1, 2);",
        'import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs"; mkdirSync("x"); writeFileSync("x/y", "");',
    ])("N: %s", (source) => {
        expect(effects(source)).toMatchObject({ opaque: [], nondeterministic: [] });
    });
});

describe("fileEffects — literal module references become dependencies", () => {
    it("lists static, dynamic-literal, mock and importActual specifiers for the graph to resolve", () => {
        const result = effects('import "./a"; await import("./b"); vi.mock("./c"); await vi.importActual("./d"); export * from "./e";');
        expect(result.specifiers.sort()).toEqual(["./a", "./b", "./c", "./d", "./e"]);
    });
    it("ignores type-only imports", () => {
        expect(effects('import type { Thing } from "commander"; import type { X } from "./x";')).toMatchObject({ opaque: [], specifiers: [] });
    });
});
