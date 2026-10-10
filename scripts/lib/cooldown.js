import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { debugLog } from "./http.js";

/**
 * Cross-command cooldown for Firecrawl quota exhaustion.
 *
 * Firecrawl's keyless tier answers quota exhaustion with HTTP 429, `reason: "credits"` and a
 * `retry_after_seconds` that is hours away (observed 4.5k–80k seconds: it is a rolling daily
 * allowance, not a burst limit). Every later command in that window would otherwise pay the
 * same failed request before falling back, and search extras would keep hitting it too. The
 * state lives in a small file so that the next process can skip Firecrawl outright.
 *
 * Records are keyed by auth mode: a cooldown hit while keyless must not block a run that has
 * since been given an API key.
 */

const FILE_NAME = "firecrawl-cooldown.json";
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function cooldownFilePath(config) {
  return path.join(config.stateDir, FILE_NAME);
}

export async function readFirecrawlCooldown(config) {
  if (!config?.stateDir) return null;
  const filePath = cooldownFilePath(config);
  let record;
  try {
    record = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") debugLog(config, `cooldown read skipped: ${error.message}`);
    return null;
  }

  const until = Date.parse(record?.until);
  if (!Number.isFinite(until)) return null;
  if (until <= Date.now()) {
    await unlink(filePath).catch(() => {});
    return null;
  }
  return { ...record, until: new Date(until).toISOString() };
}

/** The active cooldown for this auth mode, or null. */
export async function activeFirecrawlCooldown(config, authMode) {
  const record = await readFirecrawlCooldown(config);
  return record && record.auth_mode === authMode ? record : null;
}

export async function recordFirecrawlCooldown(config, { authMode, retryAfterMs, reason } = {}) {
  if (!config?.stateDir) return null;
  const waitMs =
    Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
  const now = Date.now();
  const record = {
    until: new Date(now + waitMs).toISOString(),
    auth_mode: authMode || "keyless",
    reason: reason || "credits",
    hit_at: new Date(now).toISOString(),
  };

  try {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(cooldownFilePath(config), JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    debugLog(config, `cooldown write skipped: ${error.message}`);
  }
  return record;
}

export async function clearFirecrawlCooldown(config) {
  if (!config?.stateDir) return;
  try {
    await unlink(cooldownFilePath(config));
  } catch (error) {
    if (error.code !== "ENOENT") debugLog(config, `cooldown clear skipped: ${error.message}`);
  }
}

export function cooldownSkipMessage(record) {
  return `cooldown until ${record.until} (${record.reason || "credits"})`;
}
