import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_PREFIX = "grok-search-";

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
    await mkdir(outputDir, { recursive: true });
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

export async function writeFullOutput(config, { kind, provider, label, content, extension = "txt" }) {
  await cleanupOutputDir(config);

  const outputDir = config.outputDir;
  await mkdir(outputDir, { recursive: true });
  const fileName = [
    OUTPUT_PREFIX,
    timestamp(),
    "-",
    slug(kind, "output"),
    "-",
    slug(provider, "provider"),
    "-",
    slug(label, "content"),
    ".",
    extensionFor(extension),
  ].join("");
  const fullPath = path.join(outputDir, fileName);
  await writeFile(fullPath, content, "utf8");
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

export function jsonReplacer(_key, value) {
  return value === undefined ? undefined : value;
}

export function printJson(value) {
  console.log(JSON.stringify(value, jsonReplacer, 2));
}
