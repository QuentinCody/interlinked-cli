import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishArtifact, readArtifact, exportBundle, readBundle } from "./relation-store.js";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("publishes immutable complete artifacts and rejects tampered exports", () => {
    const root = mkdtempSync(join(tmpdir(), "relation-store-")); roots.push(root);
    const id = publishArtifact(root, { schema: "fixture", value: 2 });
    expect(readArtifact(root, id)).toEqual({ schema: "fixture", value: 2 });
    expect(() => readArtifact(root, "../bad")).toThrow();
    const destination = join(root, "bundle");
    exportBundle(destination, { schema: "fixture", value: 2 }, "input");
    expect(readBundle(destination)).toEqual({ schema: "fixture", value: 2 });
    const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
    writeFileSync(join(destination, "artifacts", `${manifest.digest}.json`), '{"value":3}');
    expect(() => readBundle(destination)).toThrow(/digest/);
});

it("round-trips compressed closures and rejects corrupted compressed bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "relation-compressed-")); roots.push(root);
    const payload = { source: "x".repeat(1_000_001) };
    exportBundle(root, payload, "input");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest.encoding).toBe("gzip"); expect(readBundle(root)).toEqual(payload);
    writeFileSync(join(root, "artifacts", `${manifest.digest}.json.gz`), "broken");
    expect(() => readBundle(root)).toThrow();
});
