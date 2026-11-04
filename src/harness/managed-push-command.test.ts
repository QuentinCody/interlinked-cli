import { describe, expect, it } from "vitest";
import { parseManagedPush, safeManagedPushEnvironment, shellQuote } from "./managed-push-command.js";

describe("managed push command boundary", () => {
    it("accepts one explicit protected destination and literal logging", () => {
        expect(parseManagedPush("git push origin HEAD:refs/heads/main > 'logs/push final.log' 2>&1")).toEqual({ remote: "origin", refspec: "HEAD:refs/heads/main", suffix: " > 'logs/push final.log' 2>&1" });
        expect(parseManagedPush("git push origin master")).toEqual({ remote: "origin", refspec: "master", suffix: "" });
        expect(parseManagedPush("git push origin main >> push.log")).toEqual({ remote: "origin", refspec: "main", suffix: " >> push.log" });
    });
    it.each(["git push", "git push origin feature", "git push --no-verify origin main", "git -c core.hooksPath=/dev/null push origin main", "env X=1 git push origin main", "git push origin +HEAD:main", "git push origin main && echo done", "echo 'git push origin main'", "git push origin main > $LOG", "git push origin main > $(echo log)", "git push origin main 2>/dev/null", "git push origin main\ngit status", "git push origin HEAD:refs/tags/main", "git push origin main > log; true", "git push origin main > log # note"])("retains the legacy path for %s", command => {
        expect(parseManagedPush(command)).toBeNull();
    });
    it("rejects inherited runtime and Git overrides but permits ordinary heap limits", () => {
        expect(safeManagedPushEnvironment({ PATH: "/usr/bin", NODE_OPTIONS: "--max-old-space-size=1536", GIT_PAGER: "cat" })).toBe(true);
        for (const env of [{ GIT_CONFIG_COUNT: "1" }, { GIT_DIR: "/tmp/repo" }, { NODE_OPTIONS: "--import evil" }, { NODE_PATH: "/tmp/loader" }, { BASH_ENV: "/tmp/init" }]) expect(safeManagedPushEnvironment(env)).toBe(false);
        expect(shellQuote("a'b")).toBe("'a'\\''b'");
    });
});
