#!/usr/bin/env node
/* What a correct Chotu deploy must report. Run from ops-app/, then POST {"probe":true} to the live function
 * (publishable key as Bearer + apikey) and compare: system_sha must match, fabric_selftest must be all passed.
 * Chotu is deployed by pasting files into the Supabase MCP tool, so this is how you know the paste was exact. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const src = readFileSync("supabase/functions/chotu/index.ts", "utf8");
const i = src.indexOf("const SYSTEM = `") + "const SYSTEM = `".length;
const j = src.indexOf("`;", i);
const SYSTEM = new Function("return `" + src.slice(i, j) + "`;")();
console.log("system_sha     ", createHash("sha256").update(SYSTEM, "utf8").digest("hex").slice(0, 12));
const { fabricSelfTest } = await import(pathToFileURL("supabase/functions/chotu/fabric-answer.js").href);
console.log("fabric_selftest", JSON.stringify(await fabricSelfTest()));
