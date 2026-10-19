import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { debugLog, redactSecrets } from "./http.js";

const OUTPUT_PREFIX = "grok-search-";
const RUN_RECORD_SCHEMA_VERSION = 3;

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
    debugLog(config, `output cleanup skipped: ${error.message}`);
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

async function writeJsonOutput(config, { kind, provider, label, value }) {
  return writeFullOutput(config, {
    kind,
    provider,
    label,
    content: JSON.stringify(value, null, 2),
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
 * Where a run record will be written, or null when records are off. Taking the path first
 * lets stdout name the record while the record is written last, after the stdout cut, so it
 * holds the warnings and file paths the agent actually got.
 */
export function runRecordPath(config, { kind, label }) {
  return runLogEnabled(config) ? outputPath(config, { kind: "run", provider: kind, label, extension: "json" }) : null;
}

/**
 * One JSON file per command so a run can be replayed later: query, resolved options, the
 * full answer, every source, usage, tool calls and errors. Cheap to keep (a few KB, swept by
 * the 30-day retention) and the only durable trace of what a search cost and returned.
 * `at` is a path from runRecordPath; without it a new path is chosen.
 */
export async function writeRunRecord(config, { kind, label, record, at = null }) {
  if (!runLogEnabled(config)) return null;
  try {
    if (!at) return await writeJsonOutput(config, { kind: "run", provider: kind, label, value: record });
    await mkdir(path.dirname(at), { recursive: true, mode: 0o700 });
    await writeFile(at, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    return at;
  } catch (error) {
    debugLog(config, `run record skipped: ${error.message}`);
    return null;
  }
}

/** Synchronous variant for exit paths (the deadline handler calls process.exit right after). */
export function writeRunRecordSync(config, { kind, label, record }) {
  if (!runLogEnabled(config)) return null;
  try {
    mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
    const fullPath = outputPath(config, { kind: "run", provider: kind, label, extension: "json" });
    writeFileSync(fullPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    return fullPath;
  } catch (error) {
    debugLog(config, `run record skipped: ${error.message}`);
    return null;
  }
}

/**
 * Up to `maxChars` characters from `offset`; anything less than the whole text also goes to a
 * file. `fullPath` names a file that already holds this text (an earlier run's), used instead.
 */
export async function previewText(config, { kind, provider, label, content, maxChars, offset = 0, extension = "txt", fullPath = null }) {
  const text = String(content ?? "");
  const start = Math.min(Math.max(0, offset), text.length);
  const limit = Number.isFinite(maxChars) ? Math.max(0, maxChars) : text.length;
  const end = Math.min(text.length, start + limit);
  const truncated = start > 0 || end < text.length;
  const slice = text.slice(start, end);
  const preview = end < text.length ? slice.trimEnd() : slice;
  const fullOutputPath = truncated
    ? (fullPath ?? (await writeFullOutput(config, { kind, provider, label, content: text, extension })))
    : null;

  return {
    preview,
    truncated,
    offset: start,
    original_length: text.length,
    full_output_path: fullOutputPath,
  };
}

/**
 * Text with `[grok-search]` lines before and after it. Agents often print only `content.text`
 * or `answer.text`: in Claude Code sessions up to 2026-10-09 the JSON went through a one-line
 * script in most calls and `diagnostics.warnings` was printed once in about 105. So what changes
 * how the text should be read is said inside it, as MCP's fetch server does when it truncates.
 */
export function withNotices(text, { lead = [], tail = [] } = {}) {
  const line = (message) => `[grok-search] ${message}`;
  return [...lead.map(line), text, ...tail.map(line)].filter(Boolean).join("\n\n");
}

// Agent shell tools cap what a command may print. pi's bash keeps the last 50KB in whole lines,
// and our JSON puts each long text on one line, so an oversized text loses that line and every
// line above it. Stay under the cap with room for a stderr line.
export const STDOUT_BUDGET_BYTES = 45 * 1024;
// Room for what `onCut` adds (a warning, a file path) when checking that a cut can fit at all.
const CUT_RESERVE_BYTES = 1024;

/** Bytes `printJson(value)` writes, including the trailing newline. */
export function stdoutBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") + 1;
}

/**
 * Set `holder[key]` to `compose(text)` and, when `output` then prints over `budget` bytes, shrink
 * `text` from the end until it fits. `compose` adds what must survive the cut (notices) and is
 * called again after `onCut`, which runs once before shrinking to record where the full text lives
 * (it may write a file and add a warning). Nothing is cut when `output` already fits, or when it
 * would not fit even with an empty text: cutting would then lose text without saving the rest.
 * Returns the part of `text` kept, or null when nothing was cut.
 */
export async function fitTextToStdoutBudget(output, holder, key, onCut, { budget = STDOUT_BUDGET_BYTES, compose = (text) => text } = {}) {
  const original = String(holder[key] ?? "");
  holder[key] = compose(original);
  if (stdoutBytes(output) <= budget) return null;
  holder[key] = compose("");
  const fitsEmpty = stdoutBytes(output) + CUT_RESERVE_BYTES <= budget;
  holder[key] = compose(original);
  if (!fitsEmpty) return null;

  await onCut();
  const cut = (chars) => original.slice(0, chars).trimEnd();
  let fits = 0;
  let overflows = original.length;
  while (overflows - fits > 1) {
    const mid = Math.floor((fits + overflows) / 2);
    holder[key] = compose(cut(mid));
    if (stdoutBytes(output) <= budget) fits = mid;
    else overflows = mid;
  }
  const kept = cut(fits);
  holder[key] = compose(kept);
  return kept;
}

/**
 * A text for stdout, behind one call: `output[key]` becomes a holder with up to `maxChars`
 * characters of `text` from `offset` as `text`, `chars` (text only), `original_chars`, `truncated`,
 * `full_path`, and `offset` when one was given. `[grok-search]` lines from `lead(holder)` (run once,
 * before the fit) and `tail(shown, holder)` (run per candidate cut) surround the text. When the whole
 * `output` would still print over the stdout budget, the text is cut further until it fits and
 * `cutWarning` goes to `output.diagnostics.warnings`. Whatever is not shown is in the file at
 * `full_path`: `fullPath` names one that already holds the text, else one is written as `file`
 * (`kind`, `provider`, `label`, `extension`) says. Returns the holder.
 */
export async function emitText(config, output, key, { text, maxChars, offset = null, fullPath = null, file, lead = () => [], tail = () => [], cutWarning }) {
  const preview = await previewText(config, { ...file, content: text, maxChars, offset: offset ?? 0, fullPath });
  const holder = {
    text: preview.preview,
    ...(offset == null ? {} : { offset: preview.offset }),
    chars: preview.preview.length,
    original_chars: preview.original_length,
    truncated: preview.truncated,
    full_path: preview.full_output_path,
  };
  output[key] = holder;
  const leadLines = lead(holder);
  const compose = (shown) => withNotices(shown, { lead: leadLines, tail: tail(shown, holder) });
  const kept = await fitTextToStdoutBudget(
    output,
    holder,
    "text",
    async () => {
      holder.full_path ??= fullPath ?? (await writeFullOutput(config, { ...file, content: text }));
      holder.truncated = true;
      output.diagnostics.warnings.push(cutWarning);
    },
    { compose }
  );
  if (kept != null) holder.chars = kept.length;
  return holder;
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
