import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 ** 2;

/** This short-lived process releases the compiler AST before the actual build starts. No checker or emit is invoked. */
function declarationInputs(root, files) {
    const ts = createRequire(import.meta.url)("typescript");
    const seen = new Set();
    let bytes = 0;
    let readFailed = false;
    const readFile = (path) => {
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat?.isFile()) { readFailed = true; return undefined; }
        if (!seen.has(path)) { seen.add(path); bytes += stat.size; }
        if (seen.size > MAX_FILES || bytes > MAX_BYTES) {
            readFailed = true;
            throw new Error("Build declaration input graph exceeds its bound");
        }
        return ts.sys.readFile(path);
    };
    const loaded = ts.readConfigFile(join(root, "tsconfig.json"), readFile);
    if (loaded.error) throw new Error("Build declaration configuration unavailable");
    // Product files are a conservative root superset; explicit config roots and references are retained too.
    const config = ts.parseJsonConfigFileContent(loaded.config, { ...ts.sys, readFile, readDirectory: () => [] }, root);
    if (config.errors.some(error => error.code !== 18002 && error.code !== 18003)) throw new Error("Build declaration configuration invalid");
    const options = { ...config.options, noEmit: true };
    const host = ts.createCompilerHost(options);
    host.readFile = readFile;
    const sources = files.filter(file => file.startsWith("src/") && (/\.[cm]?tsx?$/.test(file) || (options.allowJs && /\.[cm]?jsx?$/.test(file))));
    const rootNames = [...new Set([...sources.map(file => resolve(root, file)), ...config.fileNames])];
    const program = ts.createProgram({ rootNames, options, host, projectReferences: config.projectReferences });
    if (readFailed || program.getOptionsDiagnostics().length || program.getSyntacticDiagnostics().length) throw new Error("Build declaration graph unavailable");
    return program.getSourceFiles().map(file => realpathSync(file.fileName));
}

try {
    const { root, files } = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(declarationInputs(root, files)));
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
