import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEventLoopDeps, makeServerRuntime } from "./__tests__/fixtures.js";
import { nonNull } from "../../lib/non-null.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoverageEventLoop } from "./hook-coverage-loop.js";
import { createCodexAdapter } from "../adapters/codex.js";

vi.mock("../server-event-loop.js", () => ({ createEventLoop: () => ({
    evaluateEventLine: async () => ({ decision: "allow", warnings: ["existing"] }),
    evaluateUnifiedViaRuntime: async () => ({ decision: "allow", warnings: ["existing"] }),
    writeProtocolStatus: () => {},
}) }));

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("coverage on both daemon transports", () => {
    it("routes control queries and leaves malformed event handling with the original loop", async () => {
        const loop = createCoverageEventLoop(makeEventLoopDeps());
        expect(await loop.evaluateEventLine("malformed", "raw")).toMatchObject({ decision: "allow", warnings: ["existing"] });
        const query = await loop.evaluateEventLine(JSON.stringify({ hook_event: "HookCoverage", request: { operation: "status" } }), "raw");
        expect(JSON.parse(nonNull(query.additional_context))).toMatchObject({ readiness: "unmeasured" });
        expect(await loop.evaluateEventLine(JSON.stringify({ hook_event: "HookCoverage", request: { operation: "erase" } }), "raw")).toMatchObject({ decision: "block" });
    });
    it("preserves existing feedback and adds explicit unavailable coverage on raw and framed Stop", async () => {
        const deps = makeEventLoopDeps({ ctx: makeServerRuntime({ hookCoverageUnavailable: "watcher offline" }) });
        const loop = createCoverageEventLoop(deps);
        const raw = await loop.evaluateEventLine(JSON.stringify({ hook_event: "Stop" }), "raw");
        const framed = await loop.evaluateUnifiedViaRuntime(createCodexAdapter().parseHookInput({}, "Stop"));
        expect(raw.warnings).toEqual(["existing", expect.stringContaining("watcher offline")]);
        expect(framed).toEqual(raw);
    });
    it("throttles the coverage line to once per session on raw Stop, keyed by the event's session_id", async () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-coverage-loop-stop-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const deps = makeEventLoopDeps({ ctx: makeServerRuntime({ cwd: root, hookCoverageUnavailable: "watcher offline" }) });
        const loop = createCoverageEventLoop(deps);
        const stop = JSON.stringify({ hook_event: "Stop", session_id: "s1" });
        expect((await loop.evaluateEventLine(stop, "raw")).warnings).toEqual(["existing", expect.stringContaining("watcher offline")]);
        expect((await loop.evaluateEventLine(stop, "raw")).warnings).toEqual(["existing"]);
        const other = JSON.stringify({ hook_event: "Stop", session_id: "s2" });
        expect((await loop.evaluateEventLine(other, "raw")).warnings).toEqual(["existing", expect.stringContaining("watcher offline")]);
    });
});
