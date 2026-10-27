/**
 * What the three commands share: how argv becomes an options object, the usage text, and what
 * happens around a command's own work (config, proxy, output directory, deadline, run record,
 * error envelope, exit code). A command is its option table, its positional, a `finish` check
 * across fields, the hand-written parts of its usage, the label its run-record files carry, what
 * its run record looks like on an error path, and the function that does the work.
 */
import { loadConfig } from "./config.js";
import { startDeadline } from "./deadline.js";
import { cleanupOutputDir, printJson, writeRunRecord, writeRunRecordSync } from "./output.js";
import { assertProxyUsable, configureProxy } from "./proxy.js";

const TIMESTAMP_FIELD = { search: "searched_at", fetch: "fetched_at", map: "mapped_at" };
const DEADLINE_VERB = { search: "搜索", fetch: "提取", map: "映射" };

// Option types that take a value (`--flag v` or `--flag=v`). The others are switches.
const VALUE_TYPES = new Set(["string", "int", "list", "bool", "date"]);
// What an option is when its flag was not given and the entry names no default.
const TYPE_DEFAULTS = { string: "", int: null, list: null, bool: null, date: "", flag: false, toggle: null };

function joinChoices(values) {
  return values.length > 1 ? `${values.slice(0, -1).join("、")} 或 ${values.at(-1)}` : values.join("");
}

function parseValue(entry, flag, raw) {
  switch (entry.type) {
    case "int": {
      if (raw == null || raw === "") throw new Error(`${flag} 缺少数值`);
      const min = entry.min ?? 0;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${flag} 必须是 >= ${min} 的整数`);
      return parsed;
    }
    case "bool": {
      if (!/^(true|false)$/i.test(String(raw ?? ""))) throw new Error(`${flag} 只能是 true 或 false`);
      return /^true$/i.test(raw);
    }
    case "list": {
      if (raw == null || String(raw).trim() === "") throw new Error(`${flag} 缺少值`);
      return String(raw)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    case "date": {
      const date = String(raw ?? "").trim();
      if (!date) throw new Error(`${flag} 缺少值`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${flag} 必须是 ISO8601 日期（YYYY-MM-DD）`);
      // Date.parse rolls overflowing days over (2026-02-30 becomes Mar 2) instead of failing,
      // so compare the round-trip rather than just checking for NaN.
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
        throw new Error(`${flag} 不是有效日期: ${date}`);
      }
      return date;
    }
    default: {
      const text = String(raw ?? "").trim();
      if (!text) throw new Error(`${flag} 缺少值`);
      if (entry.values && !entry.values.includes(text)) throw new Error(`${flag} 只能是 ${joinChoices(entry.values)}`);
      return text;
    }
  }
}

/** An http(s) URL in its parsed form, or an argument error. */
export function httpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`URL 无效: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL 必须使用 http 或 https 协议");
  return parsed.toString();
}

/**
 * argv by an option table. Each entry is keyed by the field it fills and names its `flag` (or
 * `flags`), its `type` and, as needed, `min`, `values`, `default`, `validate` (a function whose
 * return value is stored, or which throws), `off` (the switch that sets a toggle to false) and, for
 * `const`, the `target` field and `value` it sets. For the usage text an entry carries `help`
 * (none: the flag is undocumented), `value` (the placeholder after the flag), `group` and, for a
 * toggle, `offHelp`; `config` names the config key that fills the field when the flag was not
 * given (applyConfigDefaults). `positional` is the one URL (`type: "url"`) or the query made of
 * everything left (`rest: true`). `finish` validates across fields. Returns `{ help: true }` when
 * --help was given.
 */
export function parseArgv(argv, { options, positional = null, finish = null }) {
  const byFlag = new Map();
  for (const [name, entry] of Object.entries(options)) {
    for (const flag of entry.flags ?? [entry.flag]) byFlag.set(flag, { name, entry, on: true });
    if (entry.off) byFlag.set(entry.off, { name, entry, on: false });
  }

  const out = {};
  const rest = [];
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg?.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const match = byFlag.get(flag);
    if (!match) throw new Error(`未知参数: ${arg}`);
    const { name, entry, on } = match;
    if (!VALUE_TYPES.has(entry.type)) {
      if (inline !== undefined) throw new Error(`未知参数: ${arg}`);
      if (entry.type === "const") out[entry.target] = entry.value;
      else out[name] = entry.type === "toggle" ? on : true;
      continue;
    }
    const value = parseValue(entry, flag, inline !== undefined ? inline : args.shift());
    out[name] = entry.validate ? entry.validate(value) : value;
  }

  for (const [name, entry] of Object.entries(options)) {
    if (entry.type === "const" || name in out) continue;
    out[name] = entry.default ?? TYPE_DEFAULTS[entry.type];
  }

  if (positional?.rest) {
    const text = rest.join(" ").trim();
    if (!text) throw new Error(positional.required);
    out[positional.name] = text;
  } else if (positional) {
    if (rest.length > 1) throw new Error(`只能提供一个 URL，多余参数: ${rest[1]}`);
    if (!rest.length) throw new Error(positional.required);
    out[positional.name] = positional.type === "url" ? httpUrl(rest[0]) : rest[0];
  }

  if (finish) finish(out);
  return out;
}

/** Fill every field whose flag was not given from the config key its entry names. */
export function applyConfigDefaults(args, options, config) {
  for (const [name, entry] of Object.entries(options)) {
    if (!entry.config || entry.type === "const") continue;
    if (args[name] === (entry.default ?? TYPE_DEFAULTS[entry.type])) args[name] = config[entry.config];
  }
  return args;
}

const HELP_COLUMN = 23;
const USAGE_WIDTH = 100;

function flagWithValue(entry, flags = entry.flags ?? [entry.flag]) {
  return `${flags.join(", ")}${VALUE_TYPES.has(entry.type) ? ` ${entry.value ?? "VALUE"}` : ""}`;
}

function wrapWords(head, words, width = USAGE_WIDTH) {
  const indent = " ".repeat(head.length + 1);
  const lines = [head];
  for (const word of words) {
    const current = lines.at(-1);
    if (current.length + 1 + word.length > width && current !== head) lines.push(`${indent}${word}`);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines.join("\n");
}

function formatRows(rows) {
  const pad = " ".repeat(HELP_COLUMN);
  return rows
    .map(([left, help]) => {
      const [first = "", ...more] = String(help ?? "").split("\n");
      const head = `  ${left}`;
      const lines = head.length >= HELP_COLUMN - 1 ? [head, `${pad}${first}`] : [`${head.padEnd(HELP_COLUMN)}${first}`];
      return [...lines, ...more.map((line) => `${pad}${line}`)].join("\n");
    })
    .join("\n");
}

/**
 * The --help text: a synopsis of every documented flag, `intro`, the flags grouped by `group` in
 * order of first appearance (`help` and `offHelp` are the descriptions), and `environment`, the
 * hand-written variable list.
 */
export function usageText(kind, { options, positional, intro = "", environment = "" }) {
  const documented = Object.values(options).filter((entry) => entry.help != null);
  const synopsis = documented.map((entry) =>
    entry.off ? `[${entry.flag}|${entry.off}]` : `[${flagWithValue(entry, [(entry.flags ?? [entry.flag])[0]])}]`
  );
  const groups = new Map();
  for (const entry of documented) {
    const group = entry.group ?? "Options";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([flagWithValue(entry), entry.help]);
    if (entry.off) groups.get(group).push([entry.off, entry.offHelp]);
  }
  const sections = [...groups].map(([title, rows]) => `${title}:\n${formatRows(rows)}`);
  const head = wrapWords(`Usage: node scripts/${kind}.js`, [...synopsis, `<${positional.name}>`]);
  return `${[head, intro, ...sections, environment ? `Environment:\n${environment}` : ""].filter(Boolean).join("\n\n")}\n`;
}

function errorOutput(kind, error, code, diagnostics = {}) {
  return {
    error: { message: error.message, code },
    diagnostics: {
      warnings: [],
      provider_attempts: [],
      [TIMESTAMP_FIELD[kind]]: new Date().toISOString(),
      ...diagnostics,
    },
  };
}

/**
 * Run a command: parse argv by its table, load config, set up the proxy, fill the options the
 * flags left to config, sweep the output directory, start the deadline, run the work and print
 * its result. Every exit path prints one JSON object to stdout and writes a run record when a
 * config exists: an argument error exits 2 (code ARGUMENT_ERROR, or the error's own), the deadline
 * exits 1 with DEADLINE_EXCEEDED, any other failure exits 1 with the error's code or `<KIND>_ERROR`
 * (RUNTIME_ERROR before the work started). A result carrying `error` is printed as is and exits 1.
 */
export async function runCommand({ kind, requireGrok = false, options, positional, finish = null, intro, environment, label, errorRecord, run }) {
  const usage = () => usageText(kind, { options, positional, intro, environment });
  let stage = "argument";
  let args = null;
  let config = null;
  try {
    args = parseArgv(process.argv.slice(2), { options, positional, finish });
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    stage = "config";
    config = await loadConfig({ requireGrok });
    // Every outbound request goes through global fetch, so the proxy is set up before the first one.
    configureProxy({ proxy: config.proxy, debug: config.debug });
    assertProxyUsable();
    applyConfigDefaults(args, options, config);
    await cleanupOutputDir(config);
    stage = kind;
    const deadlineSeconds = args.deadline;
    const stopDeadline = startDeadline(deadlineSeconds, () => {
      const error = new Error(`${DEADLINE_VERB[kind]}总耗时超过 deadline（>${deadlineSeconds}s），已中止`);
      const output = errorOutput(kind, error, "DEADLINE_EXCEEDED");
      const runPath = writeRunRecordSync(config, { kind, label: label(args), record: errorRecord(config, args, output) });
      if (runPath) output.diagnostics.run_path = runPath;
      printJson(output);
      console.error(error.message);
      process.exit(1);
    });
    try {
      const output = await run(args, config);
      printJson(output);
      if (output.error) {
        console.error(output.error.message);
        process.exitCode = 1;
      }
    } finally {
      stopDeadline();
    }
  } catch (error) {
    const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === kind ? `${kind.toUpperCase()}_ERROR` : "RUNTIME_ERROR");
    const output = errorOutput(kind, error, code, error.diagnostics);
    if (config) {
      const runPath = await writeRunRecord(config, { kind, label: (args && label(args)) || "error", record: errorRecord(config, args, output) });
      if (runPath) output.diagnostics.run_path = runPath;
    }
    printJson(output);
    console.error(error.message);
    if (stage === "argument") console.error(usage());
    process.exitCode = stage === "argument" ? 2 : 1;
  }
}
