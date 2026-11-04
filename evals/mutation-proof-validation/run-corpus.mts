import { execFileSync } from "node:child_process"; import { readFileSync, writeFileSync } from "node:fs";
const [cli, repoRoot, corpusPath, outPath] = process.argv.slice(2);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { faults: { id: string; path: string; find: string; replace: string; tests: string[]; expected: string }[] };
const rows: Record<string, unknown>[] = [];
for (const f of corpus.faults) {
  const args = ["tsx", `${cli}/src/index.ts`, "tests", "prove-kill", "--cwd", repoRoot, "--file", f.path, "--find", f.find, "--replace", f.replace, "--json"];
  for (const t of f.tests) args.push("--test", t);
  const started = Date.now(); let exit = 0, stdout = "";
  try { stdout = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000, cwd: cli }); }
  catch (e) { const err = e as { status?: number; stdout?: string }; exit = err.status ?? -1; stdout = err.stdout ?? ""; }
  let parsed: Record<string, unknown> = {}; try { parsed = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{")))); } catch { parsed = { unparsed: stdout.slice(0, 300) }; }
  const receipt = parsed.receipt as { verdict?: string; baseline?: { durationMs: number }; underMutant?: { durationMs: number } } | undefined;
  const verdict = receipt?.verdict ?? (parsed.verdict as string | undefined) ?? "error";
  rows.push({ id: f.id, expected: f.expected, verdict, match: verdict === f.expected, exit, wallMs: Date.now() - started, baselineMs: receipt?.baseline?.durationMs ?? null, mutantMs: receipt?.underMutant?.durationMs ?? null, reasons: (parsed.reasons as string[] | undefined)?.slice(0, 3) ?? null });
  console.log(`${f.id.padEnd(10)} expected=${f.expected.padEnd(12)} got=${verdict.padEnd(14)} ${verdict === f.expected ? "MATCH" : "DIFF "} exit=${exit} ${Date.now() - started} ms`);
}
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), repoRoot, rows }, null, 1));
