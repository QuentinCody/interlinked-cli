import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildAtomically,
    REQUIRED_OUTPUTS,
    validateDistribution,
} from "./build-atomic.mjs";
import { acquireBuildLease, buildLeasePath } from "./build-lease.mjs";
import { BUILD_INPUT_MARKER } from "./build-publish.mjs";

const roots = [];
it("passes the frozen build fingerprint to the bundler for embedded evidence identity", async () => {
    const root = makeRoot();
    const fingerprints = [];
    await buildAtomically({ root, fingerprintInputs: () => "a".repeat(64),
        populateStage: (_root, stage, fingerprint) => { fingerprints.push(fingerprint); populateRequiredDistribution(stage); },
        validateStage: () => {}, publishStage: () => {} });
    expect(fingerprints).toEqual(["a".repeat(64)]);
});
const NODE_SHEBANG = "#!/usr/bin/env node";
const NEW_BUILD_SOURCES = [
    "scripts/build-atomic.mjs",
    "scripts/build-atomic-cli.mjs",
    "scripts/build-atomic.test.mjs",
    "scripts/build-input-fingerprint.mjs",
    "scripts/build-lease.mjs",
    "scripts/build-publish.mjs",
];

function makeRoot() {
    const root = mkdtempSync(join(tmpdir(), "interlinked-runtime-build-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "runtime.ts"), "export const version = 1;\n");
    return root;
}

function writeNested(root, rel, content, mode) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (mode !== undefined) chmodSync(target, mode);
    return target;
}

function liveHook(root, body = "working sentinel", mode = 0o751) {
    return writeNested(root, "dist/hook-entry.js", `${NODE_SHEBANG}\n// ${body}\n`, mode);
}

function noBuildStagesRemain(root) {
    return readdirSync(root).every((name) => !name.startsWith(".dist-build-"));
}

function populateRequiredDistribution(stage) {
    for (const rel of REQUIRED_OUTPUTS) {
        const executable = rel === "index.js" || rel === "hook-entry.js";
        writeNested(stage, rel, executable ? `${NODE_SHEBANG}\n` : "artifact\n", executable ? 0o755 : 0o644);
    }
}

function workingProbeHook() {
    return `${NODE_SHEBANG}\n` +
        `if (process.argv.includes("--runner=__interlinked_bootstrap_probe__")) {\n` +
        `  process.stderr.write("[interlinked] unknown runner id: __interlinked_bootstrap_probe__\\n");\n` +
        `}\n`;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime-preserving distribution build", () => {
    it("keeps the package build command on the leased staging entry point", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        expect(pkg.scripts.build).toBe("node scripts/build-atomic-cli.mjs");
    });

    it("ships every new build module despite the scripts blanket-ignore", () => {
        const root = new URL("../", import.meta.url);
        const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
        for (const rel of NEW_BUILD_SOURCES) {
            expect(existsSync(new URL(rel, root))).toBe(true);
            expect(ignore).toContain(`!${rel}`);
        }
    });

    it("requires the public demo-runtime and reporter declaration outputs", () => {
        expect(REQUIRED_OUTPUTS).toContain("lib/demo-runtime/index.d.ts");
        expect(REQUIRED_OUTPUTS).toContain("lib/viz/reporter-vitest.d.ts");
        expect(REQUIRED_OUTPUTS).toContain("viz/mutation-runs.html");
        expect(REQUIRED_OUTPUTS).toContain(".npmignore");
    });

    it("requires the exact shebang line rather than an accepted prefix", () => {
        const root = makeRoot();
        const stage = join(root, "stage");
        mkdirSync(stage);
        populateRequiredDistribution(stage);
        writeFileSync(join(stage, "index.js"), "#!/usr/bin/env node-extra\n");

        expect(() => validateDistribution(stage)).toThrow("invalid Node shebang: index.js");
    });

    it("rejects a shebang-only hook that initializes no runtime", () => {
        const root = makeRoot();
        const stage = join(root, "stage");
        mkdirSync(stage);
        populateRequiredDistribution(stage);

        expect(() => validateDistribution(stage)).toThrow("hook runtime self-check failed");

        writeFileSync(join(stage, "hook-entry.js"), workingProbeHook());
        expect(() => validateDistribution(stage)).not.toThrow();
    });

    it("preserves the working hook byte-for-byte and mode-for-mode when bundling fails", async () => {
        const root = makeRoot();
        const hook = liveHook(root);
        const before = readFileSync(hook);
        const beforeMode = statSync(hook).mode & 0o777;

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "hook-entry.js", "replacement was incomplete\n");
                    throw new Error("simulated bundler failure");
                },
                validateStage: () => {
                    throw new Error("readiness check must not run");
                },
            }),
        ).rejects.toThrow("simulated bundler failure");

        expect(readFileSync(hook)).toEqual(before);
        expect(statSync(hook).mode & 0o777).toBe(beforeMode);
        expect(noBuildStagesRemain(root)).toBe(true);
        expect(existsSync(buildLeasePath(root))).toBe(false);
    });

    it("preserves the working hook when staged readiness validation fails", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "still working");

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// incomplete\n`, 0o755);
                },
                validateStage: () => {
                    throw new Error("simulated finalizer validation failure");
                },
            }),
        ).rejects.toThrow("simulated finalizer validation failure");

        expect(readFileSync(hook, "utf8")).toContain("still working");
        expect(noBuildStagesRemain(root)).toBe(true);
    });

    it("publishes shared assets before the hook and retains old lazy chunks", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "old hook");
        writeNested(root, "dist/chunk-OLDGEN01.js", "export const oldGeneration = true;\n");

        await buildAtomically({
            root,
            populateStage: (_projectRoot, stage) => {
                writeNested(stage, "chunk-NEWGEN01.js", "export const newGeneration = true;\n");
                writeNested(stage, "viz/index.html", "<main>new asset</main>\n", 0o640);
                writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// new hook\n`, 0o755);
            },
            validateStage: () => {},
        });

        expect(readFileSync(hook, "utf8")).toContain("new hook");
        expect(statSync(hook).mode & 0o777).toBe(0o755);
        expect(statSync(join(root, "dist", "viz", "index.html")).mode & 0o777).toBe(0o640);
        expect(readFileSync(join(root, "dist", "chunk-OLDGEN01.js"), "utf8")).toContain("oldGeneration");
        expect(readFileSync(join(root, "dist", "chunk-NEWGEN01.js"), "utf8")).toContain("newGeneration");
        expect(readFileSync(join(root, "dist", BUILD_INPUT_MARKER), "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    });

    it("packages only the current generation while retaining stale chunks for live readers", async () => {
        const root = makeRoot();
        writeFileSync(
            join(root, "package.json"),
            `${JSON.stringify({ name: "atomic-pack-proof", version: "1.0.0", files: ["dist/"] })}\n`,
        );
        liveHook(root, "old hook before package build");
        writeNested(root, "dist/chunk-STALEGEN.js", "export const stale = true;\n");
        writeNested(root, "dist/assets/stale.json", "{\"stale\":true}\n");

        await buildAtomically({
            root,
            populateStage: (_projectRoot, stage) => {
                writeNested(stage, "chunk-CURRENTGEN.js", "export const current = true;\n");
                writeNested(stage, "assets/current.json", "{\"current\":true}\n");
                writeNested(stage, "index.js", `${NODE_SHEBANG}\n// current cli\n`, 0o755);
                writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// current hook\n`, 0o755);
            },
            validateStage: () => {},
        });

        // Runtime safety and release hygiene are simultaneous requirements:
        // the old chunk remains addressable, but npm must never publish it.
        expect(existsSync(join(root, "dist", "chunk-STALEGEN.js"))).toBe(true);
        const packed = spawnSync(
            "npm",
            ["pack", "--dry-run", "--ignore-scripts", "--json"],
            { cwd: root, encoding: "utf8" },
        );
        expect(packed.status, packed.stderr).toBe(0);
        const [{ files }] = JSON.parse(packed.stdout);
        const paths = files.map((file) => file.path);
        expect(paths).toContain("dist/chunk-CURRENTGEN.js");
        expect(paths).toContain("dist/assets/current.json");
        expect(paths).not.toContain("dist/chunk-STALEGEN.js");
        expect(paths).not.toContain("dist/assets/stale.json");
    });

    it("keeps the old hook executable when publication fails after a new shared chunk lands", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "old hook before interrupted publish");
        const before = readFileSync(hook);
        const oldIndex = writeNested(root, "dist/index.js", `${NODE_SHEBANG}\n// old cli\n`, 0o755);
        const beforeIndex = readFileSync(oldIndex);
        const beforeIndexMode = statSync(oldIndex).mode & 0o777;
        writeNested(root, "dist/chunk-OLDGEN02.js", "export const oldLazy = true;\n");

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "chunk-NEWGEN02.js", "export const newLazy = true;\n");
                    writeNested(stage, "index.js", `${NODE_SHEBANG}\n// new cli\n`, 0o755);
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// must remain unpublished\n`, 0o755);
                },
                validateStage: () => {},
                beforePublishFile: (rel) => {
                    // hook-entry.js is the final runtime-entry commit point.
                    // Failing here proves the already-published index entry is
                    // really rolled back; failing at index.js would exercise
                    // only the no-entry-published case.
                    if (rel === "hook-entry.js") throw new Error("injected mid-publish failure");
                },
            }),
        ).rejects.toThrow("injected mid-publish failure");

        expect(readFileSync(hook)).toEqual(before);
        expect(readFileSync(oldIndex)).toEqual(beforeIndex);
        expect(statSync(oldIndex).mode & 0o777).toBe(beforeIndexMode);
        expect(readFileSync(join(root, "dist", "chunk-OLDGEN02.js"), "utf8")).toContain("oldLazy");
        expect(readFileSync(join(root, "dist", "chunk-NEWGEN02.js"), "utf8")).toContain("newLazy");
        expect(existsSync(join(root, "dist", BUILD_INPUT_MARKER))).toBe(false);
    });

    it("rolls back entrypoints and the package allowlist as one publication transaction", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "old hook before package-list failure");
        const index = writeNested(root, "dist/index.js", `${NODE_SHEBANG}\n// old cli\n`, 0o755);
        const ignore = writeNested(root, "dist/.npmignore", "old-generation-only\n");
        const hookBefore = readFileSync(hook);
        const indexBefore = readFileSync(index);
        const ignoreBefore = readFileSync(ignore);

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "chunk-CURRENTROLLBACK.js", "export const current = true;\n");
                    writeNested(stage, "index.js", `${NODE_SHEBANG}\n// new cli\n`, 0o755);
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// new hook\n`, 0o755);
                },
                validateStage: () => {},
                beforePublishFile: (rel) => {
                    if (rel === ".npmignore") throw new Error("injected package-list failure");
                },
            }),
        ).rejects.toThrow("injected package-list failure");

        expect(readFileSync(hook)).toEqual(hookBefore);
        expect(readFileSync(index)).toEqual(indexBefore);
        expect(readFileSync(ignore)).toEqual(ignoreBefore);
        expect(existsSync(join(root, "dist", BUILD_INPUT_MARKER))).toBe(false);
    });

    it("rejects a symlinked dist before changing bytes outside the distribution", async () => {
        const root = makeRoot();
        const outside = join(root, "outside-dist");
        mkdirSync(outside);
        const sentinel = writeNested(root, "outside-dist/hook-entry.js", "outside sentinel\n");
        const before = readFileSync(sentinel);
        rmSync(join(root, "dist"), { recursive: true });
        symlinkSync(outside, join(root, "dist"), "dir");

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// redirected\n`, 0o755);
                },
                validateStage: () => {},
            }),
        ).rejects.toThrow("distribution path must not be a symbolic link");

        expect(readFileSync(sentinel)).toEqual(before);
        expect(noBuildStagesRemain(root)).toBe(true);
    });

    it("rejects a nested live symlink before changing its outside target", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "live hook before nested redirect");
        const hookBefore = readFileSync(hook);
        const outside = join(root, "outside-viz");
        mkdirSync(outside);
        const sentinel = writeNested(root, "outside-viz/index.html", "outside page\n");
        const before = readFileSync(sentinel);
        symlinkSync(outside, join(root, "dist", "viz"), "dir");

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "viz/index.html", "replacement page\n");
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// replacement hook\n`, 0o755);
                },
                validateStage: () => {},
            }),
        ).rejects.toThrow("dist/viz");

        expect(readFileSync(sentinel)).toEqual(before);
        expect(readFileSync(hook)).toEqual(hookBefore);
        expect(noBuildStagesRemain(root)).toBe(true);
    });

    it("aborts before publishing live entries when a product source changes during the build", async () => {
        const root = makeRoot();
        const hook = liveHook(root, "old hook after moving-input abort");
        const before = readFileSync(hook);

        await expect(
            buildAtomically({
                root,
                populateStage: (_projectRoot, stage) => {
                    writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// stale replacement\n`, 0o755);
                    writeFileSync(join(root, "src", "runtime.ts"), "export const version = 2;\n");
                },
                validateStage: () => {},
            }),
        ).rejects.toThrow("Build inputs changed while bundling");

        expect(readFileSync(hook)).toEqual(before);
        expect(existsSync(join(root, "dist", BUILD_INPUT_MARKER))).toBe(false);
    });

    it("coalesces a waiting equivalent build instead of launching a second compiler", async () => {
        const root = makeRoot();
        liveHook(root, "old coalescing hook");
        let populateCalls = 0;
        let announceEntered;
        let resumeFirst;
        const entered = new Promise((resolveEntered) => {
            announceEntered = resolveEntered;
        });
        const hold = new Promise((resolveHold) => {
            resumeFirst = resolveHold;
        });
        const leaseOptions = { waitMs: 1_000, pollMs: 5, staleMs: 10_000 };

        const first = buildAtomically({
            root,
            leaseOptions,
            populateStage: async (_projectRoot, stage) => {
                populateCalls += 1;
                populateRequiredDistribution(stage);
                writeFileSync(join(stage, "hook-entry.js"), workingProbeHook());
                announceEntered();
                await hold;
            },
            validateStage: () => {},
        });
        await entered;
        const second = buildAtomically({
            root,
            leaseOptions,
            populateStage: (_projectRoot, stage) => {
                populateCalls += 1;
                writeNested(stage, "hook-entry.js", `${NODE_SHEBANG}\n// duplicate compiler\n`, 0o755);
            },
            validateStage: () => {},
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        resumeFirst();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual({ coalesced: false });
        expect(secondResult).toEqual({ coalesced: true });
        expect(populateCalls).toBe(1);
    });

    it("bounds lease waiting and recovers a dead owner", async () => {
        const root = makeRoot();
        const held = await acquireBuildLease(root, { waitMs: 20, pollMs: 2, staleMs: 10_000 });
        try {
            await expect(
                acquireBuildLease(root, { waitMs: 10, pollMs: 2, staleMs: 10_000 }),
            ).rejects.toThrow("without launching a second compiler");
        } finally {
            held.release();
        }

        const lockPath = buildLeasePath(root);
        mkdirSync(lockPath);
        writeFileSync(
            join(lockPath, "owner.json"),
            `${JSON.stringify({ token: "dead-owner", pid: 999_999_999, started_at_ms: 0 })}\n`,
        );
        const recovered = await acquireBuildLease(root, {
            waitMs: 20,
            pollMs: 2,
            staleMs: 10_000,
            ownerAlive: () => false,
        });
        recovered.release();
        expect(existsSync(lockPath)).toBe(false);
    });

    it("recovers an ownerless lease left by a process that died during initialization", async () => {
        const root = makeRoot();
        const lockPath = buildLeasePath(root);
        mkdirSync(dirname(lockPath), { recursive: true });
        const child = spawnSync(
            process.execPath,
            [
                "-e",
                "require('node:fs').mkdirSync(process.argv[1]); process.exit(91)",
                lockPath,
            ],
            { encoding: "utf8" },
        );
        expect(child.status).toBe(91);
        expect(existsSync(join(lockPath, "owner.json"))).toBe(false);

        const recovered = await acquireBuildLease(root, {
            waitMs: 200,
            pollMs: 2,
            staleMs: 10_000,
            initializationGraceMs: 15,
        });
        expect(recovered.waited).toBe(true);
        recovered.release();
        expect(existsSync(lockPath)).toBe(false);
    });
});
