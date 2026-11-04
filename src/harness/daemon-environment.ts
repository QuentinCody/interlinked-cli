/** Detached services must not retain a caller's loaders or disposable paths. */
export function daemonEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...input };
    for (const [key, value] of Object.entries(env)) {
        if (key === "NODE_OPTIONS" || key === "NODE_PATH" || key.startsWith("B1_")
            || value?.replaceAll("\\", "/").includes("/scratch/")) delete env[key];
    }
    return env;
}
