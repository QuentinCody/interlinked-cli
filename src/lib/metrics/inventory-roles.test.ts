import { describe, expect, it } from "vitest";
import { isDependencyLockfile, sourceRole } from "./inventory-roles.js";

describe("dependency lockfile roles", () => {
    it.each(["yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "Podfile.lock", "Pipfile.lock", "poetry.lock", "uv.lock",
        "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "packages.lock.json", ".terraform.lock.hcl"])("retains %s as dependency configuration", name => {
        expect(isDependencyLockfile(`packages/service/${name}`)).toBe(true);
        expect(sourceRole(`packages/service/${name}`)).toBe("configuration");
    });

    it.each(["src/clock.ts", "src/file-mutation-lock.ts", "src/block.js", "src/lockfile.ts", "src/locks.py", "src\\clock.ts"])("keeps lock-named implementation %s in the product scope", path => {
        expect(isDependencyLockfile(path)).toBe(false);
        expect(sourceRole(path)).toBe("product");
    });
});

describe("test files under fixture directories (roles v3)", () => {
    // test-contract: invariant — a test FILE the runner discovers is a test wherever it lives, so the coverage index's inventory holds every executed test; everything else a fixture directory holds stays a fixture, and scratch/evals never enter the inventory
    it.each(["src/harness/checks/__fixtures__/weak-hash.fixtures.test.ts", "src/harness/structure/__tests__/fixtures/fixture-declared/test/client.test.ts", "fixtures/app/index.spec.tsx"])("classifies %s as a test", path => {
        expect(sourceRole(path)).toBe("test");
    });
    it.each(["src/harness/checks/__fixtures__/weak-hash.ts", "src/harness/structure/__tests__/fixtures/fixture-declared/src/client.ts", "scratch/2026-09-29-unit7/probe.test.ts", "evals/suite/case.test.ts"])("keeps %s out of the test role", path => {
        expect(sourceRole(path)).toBe("fixture");
    });
});
