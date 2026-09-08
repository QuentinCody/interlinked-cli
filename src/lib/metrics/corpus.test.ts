import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { measureCorpus } from "./corpus.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { root: string; manifest: string; out: string } {
    const root = mkdtempSync(join(tmpdir(), "metrics-corpus-")); roots.push(root);
    const metadata = mkdtempSync(join(tmpdir(), "metrics-corpus-output-")); roots.push(metadata);
    writeFileSync(join(root, "index.js"), "export function value() { return 1; }\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "--quiet"]); git(["add", "index.js"]);
    git(["-c", "user.name=Metrics fixture", "-c", "user.email=metrics@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const manifest = join(metadata, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ repositories: [{ name: "fixture/example", path: root, commit: git(["rev-parse", "HEAD"]).trim(), stars: 150, cohort: "held-out" }] }));
    return { root, manifest, out: join(metadata, "reports") };
}
it("persists a pinned held-out report and rejects dirty reruns", async () => {
    const options = fixture(), first = await measureCorpus(options);
    expect(first.repositories[0]?.cohort).toBe("held-out");
    expect(first.repositories[0]?.structuralScore).toBe(0);
    expect(readFileSync(join(options.out, "001.json"), "utf8")).toContain("interlinked-slop-v1");
    writeFileSync(join(options.root, "index.js"), "changed");
    const second = await measureCorpus(options);
    expect(second.repositories[0]?.status).toBe("failed");
    expect(second.repositories[0]?.error).toContain("changes");
});
