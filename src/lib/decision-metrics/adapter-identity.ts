import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function adapterIdentity(command: string): string {
    const paths = command.includes("/")
        ? [resolve(command)]
        : (process.env.PATH ?? "").split(delimiter).map((path) => resolve(path, command));
    const executable = paths.find((path) => {
        try {
            accessSync(path, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
    if (!executable) throw new Error("ThinkThen executable unavailable");
    const bytes = readFileSync(realpathSync(executable));
    return `thinkthen-cli-v2:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
