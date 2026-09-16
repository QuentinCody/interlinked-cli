import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireProjectHeavyProcessLease, tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";

const CONTENDER_PROGRAM = [
	'import { tryAcquireProjectHeavyProcessLease } from "./src/harness/project-heavy-process-lock.ts";',
	"const release = tryAcquireProjectHeavyProcessLease(process.argv[1]);",
	'process.stdout.write(release ? "acquired" : "busy");',
	"release?.();",
].join("\n");

const roots: string[] = [];

function projectRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `interlinked-heavy-${label}-`));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tryAcquireProjectHeavyProcessLease", () => {
    it("waits for the existing owner and releases the same lane", async () => {
        const root = projectRoot("wait");
        const first = tryAcquireProjectHeavyProcessLease(root);
        const pending = acquireProjectHeavyProcessLease(root, Date.now() + 1000, new AbortController().signal);
        first?.();
        const second = await pending;
        expect(second).not.toBeNull();
        expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();
        second?.();
    });

    it("leaves a busy lane untouched on deadline or cancellation", async () => {
        const root = projectRoot("deadline"), first = tryAcquireProjectHeavyProcessLease(root);
        try {
            expect(await acquireProjectHeavyProcessLease(root, Date.now() + 10, new AbortController().signal)).toBeNull();
            const controller = new AbortController();
            controller.abort();
            expect(await acquireProjectHeavyProcessLease(root, Date.now() + 1000, controller.signal)).toBeNull();
            expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();
        } finally { first?.(); }
    });
	it("admits one owner per canonical project without queueing", () => {
		const root = projectRoot("same");
		const release = tryAcquireProjectHeavyProcessLease(root);

		expect(release).not.toBeNull();
		expect(tryAcquireProjectHeavyProcessLease(root)).toBeNull();

		release?.();
		const reacquired = tryAcquireProjectHeavyProcessLease(root);
		expect(reacquired).not.toBeNull();
		reacquired?.();
	});

	it("maps symlink aliases to the same project lane", () => {
		const root = projectRoot("real");
		const alias = join(tmpdir(), `interlinked-heavy-alias-${process.pid}-${roots.length}`);
		symlinkSync(root, alias, "dir");
		roots.push(alias);

		const release = tryAcquireProjectHeavyProcessLease(root);
		expect(release).not.toBeNull();
		expect(tryAcquireProjectHeavyProcessLease(alias)).toBeNull();
		release?.();
	});

	it("refuses an independent process while this process owns the project", () => {
		const root = projectRoot("process");
		const release = tryAcquireProjectHeavyProcessLease(root);
		expect(release).not.toBeNull();

		const contender = spawnSync(
			process.execPath,
			["--import", "tsx", "--eval", CONTENDER_PROGRAM, root],
			{ cwd: process.cwd(), encoding: "utf-8", timeout: 10_000 },
		);

		expect(contender.error).toBeUndefined();
		expect(contender.status).toBe(0);
		expect(contender.stdout).toBe("busy");
		release?.();
	});

	it("keeps independent projects concurrent", () => {
		const firstRoot = projectRoot("first");
		const secondRoot = projectRoot("second");
		const first = tryAcquireProjectHeavyProcessLease(firstRoot);
		const second = tryAcquireProjectHeavyProcessLease(secondRoot);

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		first?.();
		second?.();
	});
});
