// interlinked-tdd: exempt
// -----------------------------------------------------------------------------
// Managed provider plugin/extension ownership
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

export const MANAGED_PROVIDER_FILE_MARKER = "// interlinked-provider-bridge:v1";

export function isManagedProviderFile(content: string): boolean {
    return content.startsWith(`${MANAGED_PROVIDER_FILE_MARKER}\n`);
}

export function managedProviderFileHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

/** Remove a provider bridge only when it is recognizably ours and, when a
 * manifest hash is available, has not been edited since installation. */
type ManagedProviderFileRemoval = "removed" | "missing" | "foreign" | "modified";

export function removeManagedProviderFile(
    path: string,
    expectedHash: string | undefined,
    dryRun: boolean,
): ManagedProviderFileRemoval {
    if (!existsSync(path)) return "missing";
    const content = readFileSync(path, "utf-8");
    if (!isManagedProviderFile(content)) return "foreign";
    if (expectedHash !== undefined && managedProviderFileHash(content) !== expectedHash) {
        return "modified";
    }
    if (!dryRun) unlinkSync(path);
    return "removed";
}
