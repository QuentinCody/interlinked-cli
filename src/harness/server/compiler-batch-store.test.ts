import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeEvent } from "../__tests__/fixtures/evaluator.js";
import { completeCompilerBatch, readCompilerBatch, writeCompilerBatch } from "./compiler-batch-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "compiler-store-"));
    roots.push(root);
    const event = makeEvent({ session_id: "../../untrusted-id", cwd: root });
    const batch = { revision: "", paths: [join(root, "a.ts")], calls: ["call"], blocking: [] };
    writeCompilerBatch(root, event, batch);
    return { root, event, batch };
}
it("retains pending paths across readers, with session and subagent isolation", () => {
    const { root, event, batch } = fixture();
    expect(readCompilerBatch(root, event).paths).toEqual(batch.paths);
    expect(readCompilerBatch(root, { ...event, session_id: "other" }).paths).toEqual([]);
    expect(readCompilerBatch(root, { ...event, subagent_id: "child" }).paths).toEqual([]);
});
it("does not clear an edit queued while verification was running", () => {
    const { root, event, batch } = fixture();
    const checked = readCompilerBatch(root, event);
    writeCompilerBatch(root, event, { ...batch, calls: ["new"] });
    expect(completeCompilerBatch(root, event, checked, [], false)).toBe(false);
    const current = readCompilerBatch(root, event);
    expect(current.calls).toEqual(["new"]);
    expect(completeCompilerBatch(root, event, current, [], false)).toBe(true);
    expect(readCompilerBatch(root, event).paths).toEqual([]);
});
it("treats a corrupt pending record as missing evidence, not an empty queue", () => {
    const { root, event } = fixture();
    const directory = join(root, ".interlinked/compiler-batches");
    writeFileSync(join(directory, readdirSync(directory)[0]!), "{bad");
    expect(() => readCompilerBatch(root, event)).toThrow();
});
