#!/usr/bin/env node
import assert from "node:assert/strict";
import { applyConfigDefaults, httpUrl, parseArgv, usageText } from "../scripts/lib/cli.js";

const OPTIONS = {
  name: { flag: "--name", type: "string" },
  mode: { flag: "--mode", type: "string", default: "auto", values: ["auto", "fast"] },
  count: { flag: "--count", type: "int", min: 1 },
  limit: { flag: "--limit", type: "int", min: 0, default: 10 },
  strict: { flag: "--strict", type: "bool" },
  domains: { flag: "--domains", type: "list" },
  since: { flag: "--since", type: "date" },
  verbose: { flag: "--verbose", type: "flag" },
  images: { flag: "--images", off: "--no-images", type: "toggle" },
  modeAlias: { flags: ["--fast", "--quick"], type: "const", target: "mode", value: "fast" },
  upper: { flag: "--upper", type: "string", validate: (value) => value.toUpperCase() },
};

function parse(argv, extra = {}) {
  return parseArgv(argv, { options: OPTIONS, positional: { name: "query", rest: true, required: "缺少 query" }, ...extra });
}

function throwsWith(fn, pattern) {
  assert.throws(fn, (error) => pattern.test(error.message));
}

// Defaults: a named default, else the type's own.
assert.deepEqual(parse(["a", "b"]), {
  name: "",
  mode: "auto",
  count: null,
  limit: 10,
  strict: null,
  domains: null,
  since: "",
  verbose: false,
  images: null,
  upper: "",
  query: "a b",
});

// Both spellings of a value, every value type.
const both = parse(["--name", "x", "--count=3", "--strict", "TRUE", "--domains=a.com, b.com,,", "--since", "2026-02-28", "--upper=abc", "q"]);
assert.equal(both.name, "x");
assert.equal(both.count, 3);
assert.equal(both.strict, true);
assert.deepEqual(both.domains, ["a.com", "b.com"]);
assert.equal(both.since, "2026-02-28");
assert.equal(both.upper, "ABC");

// Switches, toggles and const aliases take no value.
assert.equal(parse(["--verbose", "q"]).verbose, true);
assert.equal(parse(["--images", "q"]).images, true);
assert.equal(parse(["--no-images", "q"]).images, false);
assert.equal(parse(["--images", "--no-images", "q"]).images, false);
assert.equal(parse(["--fast", "q"]).mode, "fast");
assert.equal(parse(["--quick", "q"]).mode, "fast");
assert.deepEqual(Object.keys(parse(["q"])).includes("modeAlias"), false);
throwsWith(() => parse(["--verbose=1", "q"]), /未知参数: --verbose=1/);

// Help wins wherever it appears.
assert.deepEqual(parse(["q", "--help"]), { help: true });
assert.deepEqual(parse(["-h"]), { help: true });

// Argument errors name the flag.
throwsWith(() => parse(["--bogus", "q"]), /未知参数: --bogus/);
throwsWith(() => parse(["--name", "", "q"]), /--name 缺少值/);
throwsWith(() => parse(["--name=", "q"]), /--name 缺少值/);
throwsWith(() => parse(["--count", "q"]), /--count 必须是 >= 1 的整数/);
throwsWith(() => parse(["--count=0", "q"]), /--count 必须是 >= 1 的整数/);
throwsWith(() => parse(["--count"]), /--count 缺少数值/);
throwsWith(() => parse(["--strict", "yes", "q"]), /--strict 只能是 true 或 false/);
throwsWith(() => parse(["--domains=", "q"]), /--domains 缺少值/);
throwsWith(() => parse(["--since", "2026-2-1", "q"]), /--since 必须是 ISO8601 日期/);
throwsWith(() => parse(["--since", "2026-02-30", "q"]), /--since 不是有效日期: 2026-02-30/);
throwsWith(() => parse(["--mode", "slow", "q"]), /--mode 只能是 auto 或 fast/);
throwsWith(() => parse([]), /缺少 query/);
throwsWith(() => parse(["--verbose"]), /缺少 query/);

// A single URL positional.
const url = parseArgv(["--limit", "2", "https://example.com/a?b=1"], {
  options: OPTIONS,
  positional: { name: "url", type: "url", required: "缺少 URL" },
});
assert.equal(url.url, "https://example.com/a?b=1");
assert.equal(url.limit, 2);
throwsWith(() => parseArgv([], { options: OPTIONS, positional: { name: "url", type: "url", required: "缺少 URL" } }), /缺少 URL/);
throwsWith(() => parseArgv(["a", "b"], { options: OPTIONS, positional: { name: "url", type: "url", required: "缺少 URL" } }), /只能提供一个 URL，多余参数: b/);
throwsWith(() => parseArgv(["not a url"], { options: OPTIONS, positional: { name: "url", type: "url", required: "缺少 URL" } }), /URL 无效: not a url/);
throwsWith(() => parseArgv(["ftp://x.test/a"], { options: OPTIONS, positional: { name: "url", type: "url", required: "缺少 URL" } }), /http 或 https/);
assert.equal(httpUrl("HTTP://Example.com"), "http://example.com/");

// finish sees the filled object and may reshape it or throw.
const finished = parse(["--count", "2", "q"], {
  finish(args) {
    if (args.count > 1 && args.verbose) throw new Error("conflict");
    args.doubled = args.count * 2;
  },
});
assert.equal(finished.doubled, 4);
throwsWith(() => parse(["--count", "2", "--verbose", "q"], { finish: (args) => { if (args.verbose) throw new Error("conflict"); } }), /conflict/);

// Config fills what the flags left at their defaults, and only that.
{
  const options = {
    model: { flag: "--model", type: "string", config: "grokModel" },
    turns: { flag: "--turns", type: "int", min: 1, config: "maxTurns" },
    images: { flag: "--images", off: "--no-images", type: "toggle", config: "images" },
    chars: { flag: "--chars", type: "int", min: 0, default: 100 },
    alias: { flags: ["--fast"], type: "const", target: "model", value: "fast" },
  };
  const config = { grokModel: "grok-4.3", maxTurns: 3, images: true };
  const filled = applyConfigDefaults(parseArgv(["q"], { options }), options, config);
  assert.deepEqual(filled, { model: "grok-4.3", turns: 3, images: true, chars: 100 });
  const given = applyConfigDefaults(parseArgv(["--model", "m", "--turns", "1", "--no-images", "--chars", "5"], { options }), options, config);
  assert.deepEqual(given, { model: "m", turns: 1, images: false, chars: 5 });
}

// Usage comes from the table: every documented flag in the synopsis (wrapped at 100 columns),
// grouped help with a wide flag pushing its help to the next line, the given intro and environment.
{
  const text = usageText("fetch", {
    options: {
      provider: { flag: "--provider", type: "string", values: ["auto", "direct"], value: "auto|direct", help: "Which provider" },
      quiet: { flag: "--quiet", type: "flag", help: "Say less" },
      images: { flag: "--images", off: "--no-images", type: "toggle", group: "Media", help: "Analyze images", offHelp: "Do not" },
      long: { flag: "--a-rather-long-flag-name", type: "int", value: "N", group: "Media", help: "Wraps to the\nnext line" },
      alias: { flags: ["--old"], type: "const", target: "quiet", value: true },
    },
    positional: { name: "url", type: "url", required: "缺少 URL" },
    intro: "Fetch a page.",
    environment: "  TAVILY_API_KEY       Optional",
  });
  assert.equal(
    text,
    [
      "Usage: node scripts/fetch.js [--provider auto|direct] [--quiet] [--images|--no-images]",
      "                             [--a-rather-long-flag-name N] <url>",
      "",
      "Fetch a page.",
      "",
      "Options:",
      "  --provider auto|direct",
      "                       Which provider",
      "  --quiet              Say less",
      "",
      "Media:",
      "  --images             Analyze images",
      "  --no-images          Do not",
      "  --a-rather-long-flag-name N",
      "                       Wraps to the",
      "                       next line",
      "",
      "Environment:",
      "  TAVILY_API_KEY       Optional",
      "",
    ].join("\n")
  );
}

console.log("cli fixtures ok");
