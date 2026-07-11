import { createHash } from "node:crypto";

const asPattern = (source, flags = "i") => ({ source, flags });

function truthSnapshot(fields) {
  const normalized = JSON.stringify(fields);
  return {
    fields,
    normalized_snapshot_sha256: createHash("sha256").update(normalized).digest("hex"),
  };
}

export const benchmarkDate = "2026-07-11";

export const questions = [
  {
    id: "node",
    track: "latest_exact_fact",
    title: "Node.js 最新 LTS / Current",
    query: "截至 2026-07-11，请查明 Node.js 官方当前最新 LTS 与最新 Current 的完整版本号、LTS 代号或 Current 状态，以及各自完整版本的发布日期。不要使用主版本分支首次发布日期。给出官方 URL，不超过 260 个汉字。",
    gold_urls: ["https://nodejs.org/dist/index.json", "https://nodejs.org/en/about/previous-releases"],
    official_domains: ["nodejs.org"],
    truth: truthSnapshot({ lts: "v24.18.0", lts_codename: "Krypton", lts_date: "2026-06-23", current: "v26.5.0", current_date: "2026-07-08" }),
    criteria: [asPattern("v?24\\.18\\.0"), asPattern("Krypton"), asPattern("2026[-年/.]0?6[-月/.]23|June\\s+23,?\\s+2026"), asPattern("v?26\\.5\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?8|July\\s+8,?\\s+2026")],
    stale_markers: [asPattern("v?24\\.17\\.0|v?26\\.4\\.0")],
    verifier_answer: "Node.js 最新 LTS 是 v24.18.0（Krypton），发布于 2026-06-23；最新 Current 是 v26.5.0，发布于 2026-07-08。",
  },
  {
    id: "rust",
    track: "latest_exact_fact",
    title: "Rust 最新稳定版",
    query: "截至 2026-07-11，请从 Rust 官方发布说明查明最新稳定版完整版本号、发布日期，并概括两个最重要的稳定化变化。给出官方 URL，不超过 320 个汉字。",
    gold_urls: ["https://blog.rust-lang.org/2026/07/09/Rust-1.97.0/"],
    official_domains: ["rust-lang.org"],
    truth: truthSnapshot({ version: "1.97.0", date: "2026-07-09", changes: ["symbol mangling v0 default", "CARGO_BUILD_WARNINGS=deny"] }),
    criteria: [asPattern("1\\.97\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?9|July\\s+9,?\\s+2026"), asPattern("(symbol|符号).{0,45}(mangl|重整).{0,25}v0|mangl.{0,35}v0", "is"), asPattern("CARGO_BUILD_WARNINGS|cargo.{0,100}(deny|拒绝).{0,45}(warning|警告)", "is")],
    stale_markers: [asPattern("1\\.96\\.[0-9]+")],
    verifier_answer: "Rust 最新稳定版为 1.97.0，发布于 2026-07-09；主要变化包括默认启用 symbol mangling v0，以及 Cargo 可用 CARGO_BUILD_WARNINGS=deny 拒绝警告。",
  },
  {
    id: "python",
    track: "latest_exact_fact",
    title: "Python 最新稳定源码版本",
    query: "截至 2026-07-11，请从 python.org 查明当前最新稳定源码版本的完整版本号、发布日期，并说明它是 Python 3.14 的第几个 maintenance release。给出官方 URL，不超过 260 个汉字。",
    gold_urls: ["https://www.python.org/downloads/", "https://www.python.org/downloads/release/python-3146/"],
    official_domains: ["python.org"],
    truth: truthSnapshot({ version: "3.14.6", date: "2026-06-10", maintenance_release: 6 }),
    criteria: [asPattern("3\\.14\\.6"), asPattern("2026[-年/.]0?6[-月/.]10|June\\s+10,?\\s+2026"), asPattern("(sixth|第\\s*6|第六).{0,40}(maintenance|维护)", "is")],
    stale_markers: [asPattern("3\\.14\\.[0-5]")],
    verifier_answer: "Python 最新稳定源码版本为 3.14.6，发布于 2026-06-10，是 Python 3.14 的第六个 maintenance release。",
  },
  {
    id: "go",
    track: "latest_exact_fact",
    title: "Go 最新稳定版",
    query: "截至 2026-07-11，请从 go.dev 官方下载或 release history 查明最新稳定版（排除 beta/rc）的完整版本号和发布日期。给出官方 URL，不超过 220 个汉字。",
    gold_urls: ["https://go.dev/dl/?mode=json", "https://go.dev/doc/devel/release#go1.26.5"],
    official_domains: ["go.dev"],
    truth: truthSnapshot({ version: "go1.26.5", date: "2026-07-07" }),
    criteria: [asPattern("go1\\.26\\.5|\\b1\\.26\\.5\\b"), asPattern("2026[-年/.]0?7[-月/.]0?7|July\\s+7,?\\s+2026")],
    stale_markers: [asPattern("go1\\.26\\.[0-4]")],
    verifier_answer: "Go 最新稳定版是 go1.26.5，发布于 2026-07-07。",
  },
  {
    id: "github-cli",
    track: "latest_exact_fact",
    title: "GitHub CLI 最新版本",
    query: "截至 2026-07-11，请从 GitHub CLI 官方 Releases 查明最新版本号与发布日期，并概括安全修复和一个主要新功能。给出官方 URL，不超过 340 个汉字。",
    gold_urls: ["https://github.com/cli/cli/releases/tag/v2.96.0"],
    official_domains: ["github.com/cli/cli"],
    truth: truthSnapshot({ version: "v2.96.0", date: "2026-07-02", security: "GHSA-8cg3-r6g9-fpg2", feature: "release download without authentication for public repositories" }),
    criteria: [asPattern("v?2\\.96\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?2|July\\s+2,?\\s+2026"), asPattern("GHSA-8cg3-r6g9-fpg2|codespace.{0,55}jupyter.{0,110}(command execution|命令执行)", "is"), asPattern("release download.{0,110}(without authentication|无需认证|无认证|免认证)|公共仓库.{0,90}(无需|无|免).{0,25}认证|(无需|无|免).{0,12}认证.{0,35}(下载|release|公共仓库)", "is")],
    stale_markers: [asPattern("v?2\\.95\\.[0-9]+")],
    verifier_answer: "GitHub CLI 最新版是 v2.96.0，发布于 2026-07-02；它修复了恶意 Codespace 经 gh codespace jupyter 导致命令执行的问题，并支持公共仓库的 gh release download 无需认证。",
  },
  {
    id: "uv",
    track: "latest_exact_fact",
    title: "uv 最新版本",
    query: "截至 2026-07-11，请从 astral-sh/uv 官方 Releases 查明最新版本号与发布日期，并概括安全变化与 Python 运行时更新。给出官方 URL，不超过 340 个汉字。",
    gold_urls: ["https://github.com/astral-sh/uv/releases/tag/0.11.28"],
    official_domains: ["github.com/astral-sh/uv"],
    truth: truthSnapshot({ version: "0.11.28", date: "2026-07-07", security: "astral-async-zip 0.0.20 parser differential hardening", python: "GraalPy 25.1.3" }),
    criteria: [asPattern("0\\.11\\.28"), asPattern("2026[-年/.]0?7[-月/.]0?7|July\\s+7,?\\s+2026"), asPattern("astral-async-zip.{0,70}0\\.0\\.20|ZIP.{0,110}(parser|解析).{0,80}(harden|强化|差异)", "is"), asPattern("GraalPy.{0,35}25\\.1\\.3", "is")],
    stale_markers: [asPattern("0\\.11\\.2[0-7]")],
    verifier_answer: "uv 最新版是 0.11.28，发布于 2026-07-07；该版升级 astral-async-zip 到 0.0.20 以强化 ZIP parser differential 防护，并把 GraalPy 升至 25.1.3。",
  },
  {
    id: "kubernetes",
    track: "latest_exact_fact",
    title: "Kubernetes 最新稳定 Release",
    query: "截至 2026-07-11，请从 Kubernetes 官方 GitHub Releases 查明最新稳定 Release（排除 prerelease）的完整版本号和发布日期。给出官方 URL，不超过 230 个汉字。",
    gold_urls: ["https://github.com/kubernetes/kubernetes/releases/tag/v1.36.2"],
    official_domains: ["github.com/kubernetes/kubernetes", "kubernetes.io"],
    truth: truthSnapshot({ version: "v1.36.2", date: "2026-06-12" }),
    criteria: [asPattern("v?1\\.36\\.2"), asPattern("2026[-年/.]0?6[-月/.]12|June\\s+12,?\\s+2026")],
    stale_markers: [asPattern("v?1\\.36\\.[01]")],
    verifier_answer: "Kubernetes 最新非 prerelease 稳定 Release 是 v1.36.2，发布于 2026-06-12。",
  },
  {
    id: "cisa-kev",
    track: "latest_exact_fact",
    title: "CISA KEV 最新新增项",
    query: "截至 2026-07-11，请从 CISA Known Exploited Vulnerabilities 官方 catalog 查明最新 dateAdded，并列出该日期新增的全部 CVE、vendor/product 与 dueDate。给出官方 URL，不超过 440 个汉字。",
    gold_urls: ["https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"],
    official_domains: ["cisa.gov"],
    truth: truthSnapshot({ dateAdded: "2026-07-10", records: [{ cve: "CVE-2026-56291", vendor: "Balbooa", product: "Forms", dueDate: "2026-07-13" }, { cve: "CVE-2026-48939", vendor: "iCagenda", product: "iCagenda", dueDate: "2026-07-13" }] }),
    criteria: [asPattern("(dateAdded|最新).{0,45}(2026[-年/.]0?7[-月/.]10|July\\s+10,?\\s+2026)|(2026[-年/.]0?7[-月/.]10|July\\s+10,?\\s+2026).{0,45}(dateAdded|新增)", "is"), asPattern("CVE-2026-56291"), asPattern("Balbooa.{0,45}Forms", "is"), asPattern("CVE-2026-48939"), asPattern("iCagenda", "i"), asPattern("(dueDate|截止).{0,45}(2026[-年/.]0?7[-月/.]13|July\\s+13,?\\s+2026)|(2026[-年/.]0?7[-月/.]13|July\\s+13,?\\s+2026).{0,45}(dueDate|截止)", "is")],
    stale_markers: [asPattern("2026[-年/.]0?7[-月/.]0?7.{0,60}dateAdded|dateAdded.{0,60}2026[-年/.]0?7[-月/.]0?7", "is")],
    verifier_answer: "CISA KEV 最新 dateAdded 为 2026-07-10，共两项：CVE-2026-56291（Balbooa Forms）与 CVE-2026-48939（iCagenda iCagenda），dueDate 均为 2026-07-13。",
  },
  ...[
    ["bun", "Bun 最新版本", "截至 2026-07-11，请从 oven-sh/bun 官方 Releases 查明最新稳定版版本号与发布日期，并给出官方 URL，不超过 230 个汉字。", ["https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14"], ["github.com/oven-sh/bun", "bun.com"], { version: "1.3.14", date: "2026-05-13" }, [asPattern("(?:bun-v|Bun\\s+v?)?1\\.3\\.14"), asPattern("2026[-年/.]0?5[-月/.]13|May\\s+13,?\\s+2026")], [asPattern("1\\.3\\.1[0-3]")], "Bun 最新稳定版为 v1.3.14，发布于 2026-05-13。"],
    ["deno", "Deno 最新版本", "截至 2026-07-11，请从 denoland/deno 官方 Releases 查明最新稳定版版本号、发布日期，并列出两个 desktop 相关新增功能。给出官方 URL，不超过 320 个汉字。", ["https://github.com/denoland/deno/releases/tag/v2.9.2"], ["github.com/denoland/deno", "deno.com"], { version: "2.9.2", date: "2026-07-08", desktop: ["React Router autodetect", "HMR for Vite and Nuxt", "window opacity and transparency APIs"] }, [asPattern("v?2\\.9\\.2"), asPattern("2026[-年/.]0?7[-月/.]0?8|July\\s+8,?\\s+2026"), asPattern("React Router|window.{0,35}(opacity|transparency)|窗口.{0,35}(不透明|透明)", "is"), asPattern("HMR.{0,60}(Vite|Nuxt)|(Vite|Nuxt).{0,60}HMR|window.{0,35}(opacity|transparency)|窗口.{0,35}(不透明|透明)", "is")], [asPattern("v?2\\.9\\.[01]")], "Deno 最新稳定版为 v2.9.2，发布于 2026-07-08；desktop 新增 React Router 自动检测，并为 Vite/Nuxt 启用 HMR。"],
    ["actions-runner", "GitHub Actions Runner 最新版", "截至 2026-07-11，请从 actions/runner 官方 Releases 查明最新稳定版版本号、发布日期，并概括 Ubuntu 支持与 commit hash 兼容性两项变化。给出官方 URL，不超过 330 个汉字。", ["https://github.com/actions/runner/releases/tag/v2.335.1"], ["github.com/actions/runner"], { version: "v2.335.1", date: "2026-06-09", changes: ["Ubuntu 26.04 support", "64-character SHA-256 commit hashes"] }, [asPattern("v?2\\.335\\.1"), asPattern("2026[-年/.]0?6[-月/.]0?9|June\\s+9,?\\s+2026"), asPattern("Ubuntu.{0,25}26\\.04", "is"), asPattern("SHA-?256|64[- ]character|64.{0,20}(hash|哈希)", "is")], [asPattern("v?2\\.335\\.0")], "GitHub Actions Runner 最新版为 v2.335.1，发布于 2026-06-09；新增 Ubuntu 26.04 支持，并扩展 commit hash 正则以兼容 64 字符 SHA-256。"],
    ["ruff", "Ruff 最新版本", "截至 2026-07-11，请从 astral-sh/ruff 官方 Releases 查明最新版本号、发布日期，并概括一个 preview feature 与一个 bug fix。给出官方 URL，不超过 320 个汉字。", ["https://github.com/astral-sh/ruff/releases/tag/0.15.21"], ["github.com/astral-sh/ruff", "docs.astral.sh"], { version: "0.15.21", date: "2026-07-09", preview: "--add-ignore", fix: "syntax errors in individual notebook cells" }, [asPattern("0\\.15\\.21"), asPattern("2026[-年/.]0?7[-月/.]0?9|July\\s+9,?\\s+2026"), asPattern("--add-ignore"), asPattern("syntax errors?.{0,45}(notebook|cell)|notebook.{0,45}(syntax|语法)|语法错误.{0,45}(notebook|cell)|non-empty f-string|非空\\s*f-string", "is")], [asPattern("0\\.15\\.2[0]")], "Ruff 最新版为 0.15.21，发布于 2026-07-09；preview 增加 --add-ignore，bug fix 包括检测单个 notebook cell 的语法错误。"],
    ["pnpm", "pnpm 最新版本", "截至 2026-07-11，请从 pnpm/pnpm 官方 Releases 查明最新稳定版版本号、发布日期，并概括新增命令与一项性能改进。给出官方 URL，不超过 330 个汉字。", ["https://github.com/pnpm/pnpm/releases/tag/v11.11.0"], ["github.com/pnpm/pnpm", "pnpm.io"], { version: "v11.11.0", date: "2026-07-09", command: "pnpm access", performance: "reduced peak memory during cold-cache dependency resolution" }, [asPattern("v?11\\.11\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?9|July\\s+9,?\\s+2026"), asPattern("pnpm access", "i"), asPattern("(peak memory|峰值内存|峰值 RSS).{0,100}(cold-cache|冷缓存|dependency resolution|依赖解析|减少)|(cold-cache|冷缓存|dependency resolution|依赖解析).{0,100}(memory|内存|RSS|峰值)", "is")], [asPattern("v?11\\.10\\.[0-9]+")], "pnpm 最新稳定版为 v11.11.0，发布于 2026-07-09；新增 pnpm access，并降低冷缓存依赖解析期间的峰值内存。"],
  ].map(([id, title, query, gold_urls, official_domains, fields, criteria, stale_markers, verifier_answer]) => ({ id, track: "latest_exact_fact", title, query, gold_urls, official_domains, truth: truthSnapshot(fields), criteria, stale_markers, verifier_answer })),
  {
    id: "node-vs-go",
    track: "multi_source_reasoning",
    title: "Node Current 与 Go 稳定版发布时间比较",
    query: "截至 2026-07-11，请用 Node.js 与 Go 官方源分别查明最新 Node Current 和最新 Go 稳定版的版本号、发布日期，并计算哪一个发布更晚、相差几天。给出两个官方 URL，不超过 320 个汉字。",
    gold_urls: ["https://nodejs.org/dist/index.json", "https://go.dev/dl/?mode=json"],
    official_domains: ["nodejs.org", "go.dev"],
    truth: truthSnapshot({ node_current: "v26.5.0", node_date: "2026-07-08", go_stable: "go1.26.5", go_date: "2026-07-07", later: "Node.js", difference_days: 1 }),
    criteria: [asPattern("v?26\\.5\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?8|July\\s+8,?\\s+2026"), asPattern("go1\\.26\\.5|\\b1\\.26\\.5\\b"), asPattern("2026[-年/.]0?7[-月/.]0?7|July\\s+7,?\\s+2026"), asPattern("Node(?:\\.js)?.{0,40}(later|更晚|晚).{0,25}(1|一).{0,8}(day|天)|(later|更晚|晚).{0,25}(1|一).{0,8}(day|天).{0,40}Node", "is")],
    stale_markers: [asPattern("v?26\\.4\\.0|go1\\.26\\.4")],
    verifier_answer: "Node Current 是 v26.5.0（2026-07-08），Go 最新稳定版是 go1.26.5（2026-07-07）；Node.js 晚 1 天发布。",
  },
  {
    id: "rust-vs-deno",
    track: "multi_source_reasoning",
    title: "Rust 与 Deno 最新版发布时间比较",
    query: "截至 2026-07-11，请用 Rust 官方发布博客和 Deno 官方 Releases 查明二者最新稳定版版本号与发布日期，判断谁发布更晚、相差几天，并各列一个该版本变化。给出两个官方 URL，不超过 400 个汉字。",
    gold_urls: ["https://blog.rust-lang.org/2026/07/09/Rust-1.97.0/", "https://github.com/denoland/deno/releases/tag/v2.9.2"],
    official_domains: ["rust-lang.org", "github.com/denoland/deno"],
    truth: truthSnapshot({ rust: "1.97.0", rust_date: "2026-07-09", deno: "2.9.2", deno_date: "2026-07-08", later: "Rust", difference_days: 1, rust_change: "symbol mangling v0", deno_change: "React Router autodetect" }),
    criteria: [asPattern("1\\.97\\.0"), asPattern("2026[-年/.]0?7[-月/.]0?9|July\\s+9,?\\s+2026"), asPattern("v?2\\.9\\.2"), asPattern("2026[-年/.]0?7[-月/.]0?8|July\\s+8,?\\s+2026"), asPattern("Rust.{0,35}(later|更晚|晚).{0,25}(1|一).{0,8}(day|天)|(later|更晚|晚).{0,25}(1|一).{0,8}(day|天).{0,35}Rust", "is"), asPattern("mangl|符号重整|符号修饰", "i"), asPattern("React Router", "i")],
    stale_markers: [asPattern("1\\.96\\.[0-9]+|v?2\\.9\\.[01]")],
    verifier_answer: "Rust 最新版 1.97.0 发布于 2026-07-09，Deno 最新版 v2.9.2 发布于 2026-07-08；Rust 晚 1 天。Rust 变化包括 symbol mangling v0，Deno 变化包括 desktop 自动检测 React Router。",
  },
];

export function compilePatterns(patterns = []) {
  return patterns.map(({ source, flags }) => new RegExp(source, flags));
}
