import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function resolveCiBase(root, eventName, event, head = "HEAD") {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const present = (ref) => {
        assert(typeof ref === "string" && /^[a-f0-9]{40,64}$/.test(ref), "Missing or invalid event commit");
        try { return git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`); }
        catch { throw new Error(`E2e base is not in the checkout: ${ref}`); }
    };
    if (eventName === "pull_request") {
        return git("merge-base", present(event.pull_request?.head?.sha), present(event.pull_request?.base?.sha));
    }
    assert.equal(eventName, "push", `Unsupported e2e CI event: ${eventName}`);
    assert(!/^0+$/.test(event.before ?? ""), "A new ref has no e2e predecessor base");
    const base = present(event.before);
    try { git("merge-base", "--is-ancestor", base, head); }
    catch { throw new Error("E2e predecessor is not an ancestor of the head (force push)"); }
    return base;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const base = resolveCiBase(process.cwd(), process.env.GITHUB_EVENT_NAME, event);
    appendFileSync(process.env.GITHUB_ENV, `E2E_BASE=${base}\n`);
    process.stdout.write(`E2e comparison base: ${base}\n`);
}
