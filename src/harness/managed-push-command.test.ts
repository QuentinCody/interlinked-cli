import { describe, expect, it } from "vitest";
import { MANAGED_PUSH_ALLOWED_GIT_VARIABLES, parseManagedPush, safeManagedPushEnvironment, shellQuote, traceManagedPushCommand, unsafeManagedPushEnvironmentKeys } from "./managed-push-command.js";
import { MANAGED_PUSH_LAUNCHER } from "./managed-push-launcher.js";

describe("managed push command boundary", () => {
    it("adds only trace metadata to a recognized fallback command and preserves its redirection", () => {
        const command = "git push origin main > 'logs/push final.log' 2>&1";
        expect(traceManagedPushCommand(command, "trace-12345678")).toBe("INTERLINKED_VERIFICATION_TRACE='trace-12345678' " + command);
        expect(traceManagedPushCommand("git push origin main && echo done", "trace-12345678")).toBeNull();
        expect(traceManagedPushCommand(command, "$(echo injected)")).toBeNull();
    });
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
    // test-contract: public-api — IDE prompting helpers (VS Code exports GIT_ASKPASS and GIT_EDITOR in every terminal) do not refuse the handoff
    it("P1: permits the IDE prompt and editor helpers and names only the refused variables", () => {
        expect(safeManagedPushEnvironment({ GIT_ASKPASS: "/Applications/Visual Studio Code.app/askpass.sh", GIT_EDITOR: "code --wait", GIT_PAGER: "cat" })).toBe(true);
        expect(unsafeManagedPushEnvironmentKeys({ GIT_ASKPASS: "x", GIT_SSH_COMMAND: "ssh -i /tmp/key", GIT_CONFIG_COUNT: "1", NODE_OPTIONS: "--import evil", NODE_PATH: "/tmp" }))
            .toEqual(["GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "NODE_OPTIONS", "NODE_PATH"]);
        expect(unsafeManagedPushEnvironmentKeys({ GIT_DIR: "" })).toEqual([]);
    });
    // test-contract: invariant — the frozen launcher judges the same allowed list, so preparation and execution cannot disagree
    it("P2: the frozen launcher carries the same allowed GIT_* list", () => {
        expect(MANAGED_PUSH_LAUNCHER).toContain(JSON.stringify(MANAGED_PUSH_ALLOWED_GIT_VARIABLES).replace(/,/g, ", "));
        expect(MANAGED_PUSH_ALLOWED_GIT_VARIABLES).toEqual(["GIT_PAGER", "GIT_ASKPASS", "GIT_EDITOR"]);
    });
    // test-contract: invariant — the reported list is bounded and sorted so a fallback detail stays short
    it("N1: caps the reported variable names at eight", () => {
        const env = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`GIT_X${index}`, "1"]));
        expect(unsafeManagedPushEnvironmentKeys(env)).toHaveLength(8);
    });
});
