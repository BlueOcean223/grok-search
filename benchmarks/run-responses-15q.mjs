#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, normalizeOpenRouterSearchEngine } from "../scripts/lib/config.js";
import { searchGrokResponses } from "../scripts/lib/grok-responses.js";
import { configureProxyFromEnv } from "../scripts/lib/proxy.js";
import { benchmarkDate, questions } from "./lib/benchmark-15q-v2.mjs";

configureProxyFromEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(ROOT, "benchmarks", "results", `responses-15q-${benchmarkDate}.json`);

function parseArgs(argv) {
  const out = { output: DEFAULT_OUTPUT, only: new Set(), concurrency: 1, model: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") out.output = path.resolve(argv[++index]);
    else if (arg === "--only") out.only = new Set(String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--concurrency") out.concurrency = Math.max(1, Number.parseInt(argv[++index], 10) || 1);
    else if (arg === "--model") out.model = argv[++index] || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    })
  );
  return results;
}

const args = parseArgs(process.argv.slice(2));
const config = await loadConfig({ requireGrok: true });
const selected = questions.filter((question) => !args.only.size || args.only.has(question.id));
const model = args.model || config.grokModel;
const startedAt = new Date().toISOString();

const results = await runPool(selected, args.concurrency, async (question) => {
  const started = performance.now();
  try {
    const response = await searchGrokResponses(
      question.query,
      {
        platform: "",
        model,
        maxTurns: config.responsesMaxTurns,
        reasoningEffort: config.responsesReasoningEffort,
        allowedDomains: [],
        excludedDomains: [],
        includeXSearch: false,
        allowedXHandles: [],
        excludedXHandles: [],
        openRouterEngine: normalizeOpenRouterSearchEngine(config.responsesOpenRouterEngine),
      },
      config
    );
    return {
      id: question.id,
      ok: true,
      duration_ms: Math.round(performance.now() - started),
      answer: response.content,
      sources: response.sources,
      diagnostics: response.diagnostics,
    };
  } catch (error) {
    return {
      id: question.id,
      ok: false,
      duration_ms: Math.round(performance.now() - started),
      error: { code: error.code || null, message: error.message },
    };
  }
});

const payload = {
  schema_version: 1,
  benchmark: "grok-search-responses-15q",
  benchmark_date: benchmarkDate,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  provider: config.apiProvider,
  model,
  max_turns: config.responsesMaxTurns,
  results,
};

await mkdir(path.dirname(args.output), { recursive: true });
await writeFile(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: args.output, completed: results.length, successful: results.filter((item) => item.ok).length }));
