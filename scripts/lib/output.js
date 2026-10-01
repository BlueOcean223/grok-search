import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./http.js";

const OUTPUT_PREFIX = "grok-search-";
export const RUN_RECORD_SCHEMA_VERSION = 2;

function debug(config, message) {
  if (config?.debug) console.error(`[grok-search] ${message}`);
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function slug(value, fallback = "output") {
  const out = String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out || fallback;
}

function extensionFor(value) {
  const ext = String(value || "txt").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ext || "txt";
}

export async function cleanupOutputDir(config) {
  const outputDir = config?.outputDir;
  if (!outputDir) return;

  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(outputDir, { withFileTypes: true });
    const cutoff = Date.now() - (config.outputRetentionDays || 30) * 24 * 60 * 60 * 1000;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.startsWith(OUTPUT_PREFIX)) return;
        const fullPath = path.join(outputDir, entry.name);
        const fileStat = await stat(fullPath);
        if (fileStat.mtimeMs < cutoff) await unlink(fullPath);
      })
    );
  } catch (error) {
    debug(config, `output cleanup skipped: ${error.message}`);
  }
}

function outputPath(config, { kind, provider, label, extension = "txt" }) {
  const fileName = [
    OUTPUT_PREFIX,
    timestamp(),
    "-",
    slug(kind, "output"),
    "-",
    slug(provider, "provider"),
    "-",
    slug(label, "content"),
    "-",
    // Second-granularity timestamps plus slug fallbacks (e.g. CJK labels) collide
    // across parallel invocations; a random suffix keeps each file distinct.
    randomBytes(3).toString("hex"),
    ".",
    extensionFor(extension),
  ].join("");
  return path.join(config.outputDir, fileName);
}

export async function writeFullOutput(config, { kind, provider, label, content, extension = "txt" }) {
  await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  const fullPath = outputPath(config, { kind, provider, label, extension });
  await writeFile(fullPath, content, { encoding: "utf8", mode: 0o600 });
  return fullPath;
}

export async function writeJsonOutput(config, { kind, provider, label, value }) {
  return writeFullOutput(config, {
    kind,
    provider,
    label,
    content: JSON.stringify(value, jsonReplacer, 2),
    extension: "json",
  });
}

/**
 * Common head of a run record. `argv` is what the caller typed, minus any configured
 * secret that happened to be pasted into it.
 */
export function runRecordBase(kind, config, createdAt = new Date().toISOString()) {
  return {
    schema_version: RUN_RECORD_SCHEMA_VERSION,
    kind,
    created_at: createdAt,
    argv: process.argv.slice(2).map((arg) => redactSecrets(arg, config)),
  };
}

function runLogEnabled(config) {
  return Boolean(config?.outputDir) && config?.runLog !== false;
}

/**
 * One JSON file per command so a run can be replayed later: query, resolved options, the
 * full answer, every source, usage, tool calls and errors. Cheap to keep (a few KB, swept by
 * the 30-day retention) and the only durable trace of what a search cost and returned.
 */
export async function writeRunRecord(config, { kind, label, record }) {
  if (!runLogEnabled(config)) return null;
  try {
    return await writeJsonOutput(config, { kind: "run", provider: kind, label, value: record });
  } catch (error) {
    debug(config, `run record skipped: ${error.message}`);
    return null;
  }
}

/** Synchronous variant for exit paths (the deadline handler calls process.exit right after). */
export function writeRunRecordSync(config, { kind, label, record }) {
  if (!runLogEnabled(config)) return null;
  try {
    mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
    const fullPath = outputPath(config, { kind: "run", provider: kind, label, extension: "json" });
    writeFileSync(fullPath, JSON.stringify(record, jsonReplacer, 2), { encoding: "utf8", mode: 0o600 });
    return fullPath;
  } catch (error) {
    debug(config, `run record skipped: ${error.message}`);
    return null;
  }
}

export async function previewText(config, { kind, provider, label, content, maxChars, extension = "txt" }) {
  const text = String(content ?? "");
  const limit = Number.isFinite(maxChars) ? Math.max(0, maxChars) : text.length;
  const truncated = text.length > limit;
  const preview = truncated ? text.slice(0, limit).trimEnd() : text;
  const fullOutputPath = truncated
    ? await writeFullOutput(config, { kind, provider, label, content: text, extension })
    : null;

  return {
    preview,
    truncated,
    original_length: text.length,
    full_output_path: fullOutputPath,
  };
}

// Agent shell tools cap what a command may print. pi's bash keeps the last 50KB in whole lines,
// and our JSON puts each long text on one line, so an oversized text loses that line and every
// line above it. Stay under the cap with room for a stderr line.
export const STDOUT_BUDGET_BYTES = 45 * 1024;
// Room for what `onCut` adds (a warning, a file path) when checking that a cut can fit at all.
const CUT_RESERVE_BYTES = 1024;

/** Bytes `printJson(value)` writes, including the trailing newline. */
export function stdoutBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, jsonReplacer, 2), "utf8") + 1;
}

/**
 * Shrink the string at `holder[key]` from the end until `output` prints within `budget` bytes.
 * `onCut` runs once before shrinking to record where the full text lives (it may write a file and
 * add a warning). Leaves everything untouched when `output` already fits, or when it would not fit
 * even with an empty string: cutting would then lose text without saving the rest.
 * Returns whether it cut.
 */
export async function fitTextToStdoutBudget(output, holder, key, onCut, budget = STDOUT_BUDGET_BYTES) {
  if (stdoutBytes(output) <= budget) return false;
  const original = String(holder[key] ?? "");
  holder[key] = "";
  const fitsEmpty = stdoutBytes(output) + CUT_RESERVE_BYTES <= budget;
  holder[key] = original;
  if (!fitsEmpty) return false;

  await onCut();
  const cut = (chars) => original.slice(0, chars).trimEnd();
  let fits = 0;
  let overflows = original.length;
  while (overflows - fits > 1) {
    const mid = Math.floor((fits + overflows) / 2);
    holder[key] = cut(mid);
    if (stdoutBytes(output) <= budget) fits = mid;
    else overflows = mid;
  }
  holder[key] = cut(fits);
  return true;
}

export function jsonReplacer(_key, value) {
  return value === undefined ? undefined : value;
}

export function printJson(value) {
  console.log(JSON.stringify(value, jsonReplacer, 2));
}
