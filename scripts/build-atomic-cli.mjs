#!/usr/bin/env node
import { buildAtomically } from "./build-atomic.mjs";

await buildAtomically({ mode: process.argv.includes("--e2e") ? "e2e" : "standard" });
