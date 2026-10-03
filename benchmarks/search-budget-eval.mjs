#!/usr/bin/env node
// Agent-level search budget experiment: the same questions answered by a pi agent under three
// variants of the SKILL.md budget rule (one search / about two / no number, gap rule only).
// Sends real, billed requests (agent model + Grok + Tavily/Firecrawl). Gold answers were taken
// from official sources on 2026-10-02 and go stale as projects release.
//
// Two question sets: `facts` (round 1, one official page answers each) and `research` (round 2,
// several sub-questions or a list to assemble). `--models` runs every cell once per pi model.
//
//   node benchmarks/search-budget-eval.mjs [--set facts|research] [--only id,id] [--conditions one,two,gap]
//                                          [--models provider/id,...] [--repeat N] [--concurrency N]
//                                          [--out DIR] [--score-only DIR]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Accepts 2026-09-01, 2026/9/1, 2026 年 9 月 1 日, 9 月 1 日, Sep 1, 2026, 1 September 2026. Pass every
// day an official source gives: UTC vs UTC+8 near midnight, changelog date vs publish date.
function date(...days) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const alts = days.map((day) => {
    const [y, m, d] = day.split("-").map(Number);
    const mon = `${months[m - 1]}[a-z]*\\.?`;
    return `${y}\\s*[-/.年]\\s*0?${m}\\s*[-/.月]\\s*0?${d}(?!\\d)|(?<!\\d)0?${m}\\s*月\\s*0?${d}\\s*日|${mon}\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}|0?${d}\\s+${mon}\\s+${y}`;
  });
  return new RegExp(alts.join("|"), "i");
}

/** One criterion that passes when at least `n` of the patterns match. */
const anyOf = (n, ...patterns) => ({ n, patterns });

const FACTS = [
  { id: "go", kind: "single", q: "Go 当前最新的稳定版是哪个完整版本号？哪天发布的？", criteria: [/go\s?1\.27\.1|\b1\.27\.1\b/i, date("2026-09-01")] },
  { id: "gh", kind: "single", q: "GitHub CLI（gh）最新正式版的版本号和发布日期是什么？", criteria: [/2\.102\.0/, date("2026-09-29", "2026-09-30")] },
  { id: "rust", kind: "single", q: "Rust 最新稳定版的版本号和发布日期是什么？", criteria: [/1\.99\.0/, date("2026-10-01")] },
  { id: "codex", kind: "single", q: "OpenAI Codex CLI（GitHub openai/codex）最新的正式 release 版本号和发布日期是什么？", criteria: [/0\.159\.3/, date("2026-09-30", "2026-10-01")] },
  { id: "node", kind: "two-part", q: "Node.js 当前最新的 LTS 版本和最新的 Current 版本分别是哪个完整版本号？各自哪天发布？", criteria: [/24\.21\.0/, date("2026-09-07", "2026-09-08"), /26\.10\.0/, date("2026-09-21", "2026-09-22")] },
  { id: "k8s-uv", kind: "two-part", q: "两个问题：Kubernetes 最新的稳定版本号是多少？uv（astral-sh/uv）最新版本号和发布日期是什么？", criteria: [/1\.37\.1/, /0\.12\.21/, date("2026-09-29", "2026-09-30")] },
  { id: "node-npm", kind: "multi-hop", q: "Node.js 当前最新 LTS 版本自带的 npm 是哪个版本？这个 npm 版本是哪天发布的？", criteria: [/11\.19\.0/, date("2026-07-28", "2026-07-29", "2026-07-30")] },
  { id: "k8s-minor", kind: "multi-hop", q: "Kubernetes 最新的 minor 版本线是哪个？它的 .0 版本哪天发布？这条线目前最新的补丁版本是多少？", criteria: [/1\.37\.0|1\.37(?![.\d])/, date("2026-08-26", "2026-08-27"), /1\.37\.1/] },
  { id: "pi-latest", kind: "multi-hop", q: "pi coding agent（GitHub earendil-works/pi，npm 包 @earendil-works/pi-coding-agent）最新版本号是多少？codemode 是哪个版本引入的、那个版本哪天发布？", criteria: [/0\.99\.2/, /0\.99\.0/, date("2026-09-29", "2026-09-30")] },
  { id: "pi-codemode", kind: "detail", q: "pi coding agent（earendil-works/pi）的 codemode：codemode 工具描述里内联工具声明默认的 token 预算是多少？脚本输出默认的 token 上限是多少？", criteria: [/3,?000/, /10,?000|1\s*万/] },
  { id: "pi-grok47", kind: "detail", q: "pi coding agent（earendil-works/pi）在哪个版本把 xAI 的默认模型改成了 Grok 4.7？那个版本哪天发布？", criteria: [/0\.87\.1/, date("2026-09-22", "2026-09-23")] },
  {
    id: "go-fixes",
    kind: "detail",
    q: "Go 1.27.1 修复了哪些标准库包？列出至少三个。",
    // At least three of the packages named in the release history entry.
    atLeast: { n: 3, of: [/database\/sql/, /debug\/elf/, /encoding\/json/, /net\/http/, /(?<![\w/])os(?![\w/])/, /simd/] },
  },
];

// Gold for the research set comes from kubernetes.io/blog (v1.37 "Garhwal", 16 enhancements to Stable),
// go.dev/doc/go1.27, blog.rust-lang.org 1.99.0, uv CHANGELOG 0.12.0 (2026-07-28, 22 breaking changes),
// and the chafa / timg / viu READMEs.
const RESEARCH = [
  {
    id: "versions",
    kind: "multi-entity",
    q: "Rust、Go、Node.js（LTS 和 Current 各一个）、Kubernetes 当前最新的稳定版本号分别是多少？",
    criteria: [/1\.99\.0/, /1\.27\.1/, /24\.21\.0/, /26\.10\.0/, /1\.37\.1/],
  },
  {
    id: "k8s-137",
    kind: "release-notes",
    q: "Kubernetes 1.37 的发布主题（release theme）叫什么？这个版本有哪些特性升级到了 Stable（GA）？至少列出三个。",
    criteria: [
      /Garhwal/i,
      anyOf(3, /KYAML/i, /metrics\.k8s\.io|Metrics API/i, /SELinux/i, /\bDRA\b|Dynamic Resource Allocation|ResourceClaim|device taint/i, /declared features|声明.{0,4}特性/i, /storage version migrat|存储版本迁移/i, /pod certificate|ClusterTrustBundle|Pod\s*证书/i, /watch\s?cache|WatchCacheInitialization/i),
    ],
  },
  {
    id: "go-127",
    kind: "release-notes",
    q: "Go 1.27 相比 1.26 有哪些主要变化？语言、工具链、运行时各举至少一例。",
    criteria: [
      /generic method|泛型方法|方法.{0,12}类型参数/i,
      anyOf(1, /stdversion/i, /package@version|go doc .{0,40}@/i, /go mod tidy.{0,80}(require|合并)/is, /\bbzr\b|Bazaar/i, /modernizer|atomictypes|embedlit|slicesbackward|unsafefuncs/i, /response file|@file|响应文件/i, /OutputType/),
      anyOf(1, /asynctimerchan/i, /goroutineleak|goroutine\s*(泄漏|leak)/i, /size-specialized|80\s*(byte|字节)|内存分配.{0,20}(30%|特化)|allocation.{0,40}30%/is, /traceback.{0,60}label|goroutine\s*label/is),
    ],
  },
  {
    id: "rust-199",
    kind: "release-notes",
    q: "Rust 1.99.0 稳定了哪些语言特性和 API？至少列出三个。这个版本对 Box::leak 的文档给了什么新建议？",
    criteria: [
      anyOf(3, /variadic|可变参数|VaList/i, /for_value_raw|size_of_val_raw|align_of_val_raw/, /into_non_null|from_non_null/, /Vec::(into|from)_parts/, /from_utf8_lossy_owned|into_utf8_lossy/, /set_times/, /retain_back/, /IntoIterator for (&(mut )?)?Box<\[/, /StepBy/),
      /into_non_null|unleak|round-?trip|(不|避免).{0,20}(释放|回收|dealloc)|dealloc/i,
    ],
  },
  {
    id: "uv-012",
    kind: "release-notes",
    q: "uv（astral-sh/uv）0.12.0 是哪天发布的？它有哪些破坏性变更（breaking changes）？至少列出两条。",
    criteria: [
      date("2026-07-28", "2026-07-29"),
      anyOf(2, /uv init.{0,80}(build.?system|构建系统|packag|打包|uv_build)/is, /tar\.bz2|tar\.xz|bzip2|LZMA|PEP\s*625|压缩格式|归档格式/i, /(replace|覆盖|替换).{0,40}(interpreter|解释器)|(interpreter|解释器).{0,40}(replace|覆盖|替换)/is, /pre-?release|预发布|if-necessary/i, /require-hashes/i, /MD5/i, /pylock/i, /--cert|certificate|证书/i, /--upgrade-group/i),
    ],
  },
  {
    id: "term-img",
    kind: "landscape",
    q: "在只有 SSH、没有显示器的 Linux 服务器终端里看图片，有哪些现成的工具？各自支持哪些显示方式（sixel、kitty graphics protocol、iTerm2 inline images、Unicode 字符块等）？至少列出三个工具。",
    criteria: [
      anyOf(3, /chafa/i, /timg/i, /\bviu\b/i, /icat/i, /img2sixel|libsixel/i, /catimg/i, /\btiv\b/i, /termimage/i, /imgcat/i, /ueberzug/i, /w3m/i, /lsix/i, /pixterm/i),
      anyOf(3, /sixel/i, /kitty/i, /iterm/i, /(half|quarter).?block|半块|字符块|Unicode|ANSI/i),
      /(本地|本机).{0,12}终端|终端模拟器|terminal emulator|客户端.{0,6}终端|local terminal|tmux/i,
    ],
  },
];

const SETS = { facts: FACTS, research: RESEARCH };
let QUESTIONS = FACTS;

// The budget bullet ends with this sentence in every SKILL.md version; variants swap what precedes it.
const BUDGET_TAIL = "Do not carry the previous round's conclusion words into the keywords; for the same X handle, change the gap, not the phrasing.";
const BUDGET_RE = /^- .*Do not carry the previous round's conclusion words.*$/m;
const PARALLEL_LINE = "Run the fewest commands that answer the question; run independent sub-questions in parallel. Do not chain map → fetch → search.";
const budget = (text) => (skill) => skill.replace(BUDGET_RE, `- ${text} ${BUDGET_TAIL}`);
const INTRO_RE = /^Node scripts for web search, URL fetch and site mapping\..*$/m;
const DOT_INTRO =
  "Node scripts for web search, URL fetch and site mapping. Run `npm install` once. Run scripts from the grok-search root (the directory of this SKILL.md): `cd` there or use absolute paths.";
const toDot = (skill) => skill.replaceAll("{baseDir}/scripts/", "./scripts/").replace(INTRO_RE, DOT_INTRO);

const CONDITIONS = {
  // Budget wordings (2026-10-02). `two` is the text SKILL.md had before; `sub` is what replaced it.
  one: (skill) =>
    budget("One search per question: put every sub-question into that search's `--instructions` and do not search again.")(skill).replace(
      PARALLEL_LINE,
      "Run the fewest commands that answer the question. Do not chain map → fetch → search."
    ),
  two: budget("Budget about 2 searches per question. Before a second search, name the gap it closes."),
  gap: budget("Search again only for a gap the previous results left open; name that gap before the search."),
  sub: (skill) => skill,
  // How the command examples name the scripts (2026-10-03). Each starts from the `./scripts/...`
  // text SKILL.md had before `basedir-short` was adopted.
  dot: (skill) => toDot(skill),
  bare: (skill) => toDot(skill).replaceAll("./scripts/", "scripts/"),
  basedir: (skill) =>
    toDot(skill)
      .replaceAll("./scripts/", "{baseDir}/scripts/")
      .replace(
        INTRO_RE,
        "Node scripts for web search, URL fetch and site mapping. `{baseDir}` below is the directory containing this SKILL.md: replace it with that absolute path so commands work from any working directory. Other paths here (`references/...`) are relative to it too. Run `npm install` in `{baseDir}` once."
      ),
  // `basedir` with the definition folded into the npm install sentence, nothing else added.
  "basedir-short": (skill) =>
    toDot(skill)
      .replaceAll("./scripts/", "{baseDir}/scripts/")
      .replace(INTRO_RE, "Node scripts for web search, URL fetch and site mapping. Run `npm install` once in `{baseDir}`, the directory of this SKILL.md."),
};

function parseArgs(argv) {
  const args = { set: "facts", only: null, conditions: ["one", "two", "gap"], models: [null], repeat: 1, concurrency: 4, out: null, scoreOnly: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") args.set = argv[++i];
    else if (a === "--models") args.models = argv[++i].split(",");
    else if (a === "--only") args.only = argv[++i].split(",");
    else if (a === "--conditions") args.conditions = argv[++i].split(",");
    else if (a === "--repeat") args.repeat = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--score-only") args.scoreOnly = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** A skill directory per condition: the variant SKILL.md plus links to the real scripts. */
function prepareSkill(outDir, condition) {
  const dir = path.join(outDir, "skills", condition, "grok-search");
  mkdirSync(dir, { recursive: true });
  const original = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
  if (!BUDGET_RE.test(original) || !original.includes(PARALLEL_LINE) || !INTRO_RE.test(original)) throw new Error("SKILL.md lines the variants rewrite have changed; update the variants");
  const variant = CONDITIONS[condition](original);
  if (variant === original && ["one", "two", "gap"].includes(condition)) throw new Error(`condition ${condition} left SKILL.md unchanged`);
  writeFileSync(path.join(dir, "SKILL.md"), variant);
  for (const name of ["scripts", "references", "node_modules", "package.json"]) {
    const link = path.join(dir, name);
    if (!existsSync(link)) symlinkSync(path.join(ROOT, name), link);
  }
  return dir;
}

function runOne(outDir, skillDir, question, condition, model, rep) {
  const modelTag = model ? `--${model.replace(/[^a-z0-9.]+/gi, "_")}` : "";
  const runDir = path.join(outDir, "runs", `${question.id}--${condition}${modelTag}--${rep}`);
  mkdirSync(path.join(runDir, "outputs"), { recursive: true });
  const workDir = path.join(outDir, "work");
  mkdirSync(workDir, { recursive: true });
  const prompt = `用 grok-search 查一下：${question.q} 回答简洁，给出处 URL。`;
  const started = Date.now();
  return new Promise((resolve) => {
    const modelArgs = model ? ["--model", model] : [];
    // JSON mode, ended on `agent_settled`: with the xai provider pi finishes the answer but the
    // process does not exit on its own.
    const child = spawn("pi", ["-ne", "-ns", ...modelArgs, "--skill", skillDir, "--session-dir", path.join(runDir, "session"), "--mode", "json", prompt], {
      cwd: workDir,
      env: { ...process.env, GROK_OUTPUT_DIR: path.join(runDir, "outputs") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let answer = "";
    let settled = false;
    let stderr = "";
    child.stdout.on("data", (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const m = event.message;
        if (event.type === "message_end" && m?.role === "assistant") {
          const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          if (text.trim()) answer = text;
        }
        if (event.type === "agent_settled") {
          settled = true;
          child.kill("SIGTERM");
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(path.join(runDir, "answer.txt"), answer);
      writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({ id: question.id, set: question.set, condition, requested_model: model, rep, prompt, exit: settled ? 0 : code, settled, wall_ms: Date.now() - started, stderr: stderr.slice(-2000) }, null, 2));
      resolve(runDir);
    });
  });
}

function score(question, answer) {
  if (question.atLeast) {
    const hits = question.atLeast.of.filter((re) => re.test(answer)).length;
    return { fields: Math.min(hits, question.atLeast.n), total: question.atLeast.n };
  }
  const passes = (c) => (c instanceof RegExp ? c.test(answer) : c.patterns.filter((re) => re.test(answer)).length >= c.n);
  return { fields: question.criteria.filter(passes).length, total: question.criteria.length };
}

const SCRIPT_RE = /scripts\/(search|fetch|map)\.js/;

function measure(runDir) {
  const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const answer = readFileSync(path.join(runDir, "answer.txt"), "utf8");
  const calls = { search: 0, fetch: 0, map: 0, failed: 0, exit127: 0 };
  let agentCost = 0;
  let model = null;
  const sessionDir = path.join(runDir, "session");
  const pending = new Map();
  for (const file of existsSync(sessionDir) ? readdirSync(sessionDir) : []) {
    for (const line of readFileSync(path.join(sessionDir, file), "utf8").trim().split("\n")) {
      const m = JSON.parse(line).message;
      if (m?.role === "assistant") {
        model ??= `${m.provider}/${m.model}`;
        agentCost += m.usage?.cost?.total ?? 0;
        for (const c of m.content || []) {
          if (c.type !== "toolCall") continue;
          // One bash command may run several scripts (a && b); count each.
          const cmd = String(c.arguments?.command ?? "");
          const kinds = [...cmd.matchAll(new RegExp(SCRIPT_RE, "g"))].map((x) => x[1]);
          for (const k of kinds) calls[k] += 1;
          if (kinds.length) pending.set(c.id, kinds.length);
        }
      }
      if (m?.role === "toolResult" && pending.has(m.toolCallId)) {
        const text = (m.content || []).map((c) => c.text ?? "").join("");
        if (/exited with code [1-9]/.test(text)) calls.failed += 1;
        if (/exited with code 127/.test(text)) calls.exit127 += 1;
      }
    }
  }
  // Every script writes one run record per invocation; cost lives on search records.
  let grokCost = 0;
  let records = 0;
  const outputs = path.join(runDir, "outputs");
  for (const f of existsSync(outputs) ? readdirSync(outputs) : []) {
    if (!/-run-search-/.test(f)) continue;
    records += 1;
    grokCost += JSON.parse(readFileSync(path.join(outputs, f), "utf8")).diagnostics?.cost_usd ?? 0;
  }
  const question = [...FACTS, ...RESEARCH].find((q) => q.id === meta.id);
  return { ...meta, model, answer, ...score(question, answer), calls, search_records: records, grok_cost: grokCost, agent_cost: agentCost };
}

function summarize(results) {
  const rows = [];
  const by = (key) => [...new Set(results.map((r) => r[key]))];
  for (const model of by("model"))
  for (const condition of by("condition")) {
    const rs = results.filter((r) => r.condition === condition && r.model === model);
    if (!rs.length) continue;
    const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
    rows.push({
      model,
      condition,
      runs: rs.length,
      fully_correct: rs.filter((r) => r.fields === r.total).length,
      field_accuracy: +(sum((r) => r.fields / r.total) / rs.length).toFixed(3),
      searches: sum((r) => r.search_records),
      fetches: sum((r) => r.calls.fetch),
      failed_calls: sum((r) => r.calls.failed),
      exit127: sum((r) => r.calls.exit127 ?? 0),
      grok_cost: +sum((r) => r.grok_cost).toFixed(3),
      agent_cost: +sum((r) => r.agent_cost).toFixed(3),
      median_wall_s: Math.round(rs.map((r) => r.wall_ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] / 1000),
    });
  }
  return rows;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.scoreOnly ?? args.out ?? path.join(ROOT, "benchmarks", "results", `search-budget-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
if (!args.scoreOnly) {
  QUESTIONS = SETS[args.set];
  for (const q of QUESTIONS) q.set = args.set;
  const questions = QUESTIONS.filter((q) => !args.only || args.only.includes(q.id));
  const skills = Object.fromEntries(args.conditions.map((c) => [c, prepareSkill(outDir, c)]));
  const jobs = [];
  for (let rep = 1; rep <= args.repeat; rep++)
    for (const q of questions) for (const m of args.models) for (const c of args.conditions) jobs.push([q, c, m, rep]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [q, c, m, rep] = jobs[next++];
      const runDir = await runOne(outDir, skills[c], q, c, m, rep);
      const r = measure(runDir);
      console.error(`${q.id} ${c} ${r.model} #${rep}: ${r.fields}/${r.total} searches=${r.search_records} fetches=${r.calls.fetch} grok=$${r.grok_cost.toFixed(3)} ${Math.round(r.wall_ms / 1000)}s`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
}
const runsDir = path.join(outDir, "runs");
const results = readdirSync(runsDir).map((d) => measure(path.join(runsDir, d)));
writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
const summary = summarize(results);
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.table(summary);
console.log(outDir);
