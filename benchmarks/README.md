# Public benchmark

This directory contains the public, reproducible part of the grok-search evaluation.

Included:

- `lib/benchmark-15q-v2.mjs`: frozen 15-question set, expected fields, official URLs, and deterministic patterns.
- `run-responses-15q.mjs`: provider-neutral Responses runner using the normal grok-search configuration.
- `score-responses-15q.mjs`: deterministic correctness and official-source scoring.
- `public/2026-07-11-summary.json`: sanitized aggregate sample from the original study.

Excluded from Git:

- raw provider responses and internal IDs;
- complete fetched page bodies;
- private proxy and relay configuration;
- per-request channel pricing and failure logs;
- historical Chat protocol probes.

Run a small subset first to control cost:

```bash
npm run benchmark -- --only node,rust,python
npm run benchmark:score
```

Runs write raw responses to `benchmarks/results/`, which is intentionally ignored by Git. The historical experiment archive and internal reports remain under the separate local-only `.private/` directory.

## Experiment scripts

Not part of the scored benchmark. All send real, billed requests and write one JSON per case
plus a summary to `--out DIR` (default under `benchmarks/results/`, ignored by Git). Findings and
decisions are kept in the local-only `.agent/` notes.

- `provider-compare.mjs`: the same questions, URLs and sites through Grok, Tavily, Firecrawl and
  Direct (`--part search|fetch|map|all`). Its search part reads the Tavily/Firecrawl results
  search.js returned beside Grok, which were removed on 2026-10-19; only fetch and map still run
  as designed. Used on 2026-09-08 to decide X-post routing (Direct first) and to turn extras off
  for `--source x`.
- `deepseek-compare.mjs`: DeepSeek Search / Fetch (opened 2026-10-17) against Tavily, Firecrawl
  and Direct on the same queries and URLs, and deepseek-v4-pro with its server-side `web_search`
  against `search.js` on 13 current-fact questions (`--part search|fetch|answer`, `--repeat N`).
  Needs `DEEPSEEK_API_KEY`. `--providers firecrawl` reruns one provider after a 429 and keeps the
  rest; `--part search-rescore|fetch-rescore|answer-rescore` re-judges the saved responses after a
  target or gold change. Gold was taken from official sources on 2026-10-19.
- `search-extra-compare.mjs`: which search API fills search.js's extra slot. 62 queries in seven
  kinds (English docs, releases of the past two weeks, Chinese, code, error messages, papers, X)
  through DeepSeek, DeepSeek with `lang:en`, Tavily advanced and basic, and Firecrawl; scored by the
  rank of the official page, a current fact on a top-3 card, and the union of two providers' top 3.
  Firecrawl calls are spaced 7s apart. Check the Firecrawl balance first: one run is about 124
  credits. `--rescore` re-judges the saved responses.
- `supplement-compare.mjs`: whether a search API helps a search model when its results are handed
  to the model as reference. Arms: Grok with the question as asked, Grok with keywords plus
  `--instructions` (the SKILL.md style), Grok with DeepSeek or Tavily results in the prompt,
  deepseek-v4-pro with its server-side search (with and without Tavily results), and deepseek-flash
  with DeepSeek Search/Fetch as function tools. 13 fact questions with gold, 6 research questions
  from real sessions (unscored, written out for reading). One Grok run costs $0.03–0.10.
- `fetch-fallback-compare.mjs`: where DeepSeek Fetch goes in fetch.js's auto chain. HTML pages
  from the run records through DeepSeek Fetch, Tavily Extract and Direct, scored against each
  other and the copy on record; chains replayed as fetch.js takes them (first text wins). Run on
  2026-10-19 with Tavily out of credits, so only DeepSeek and Direct were compared. `--report`
  rescores the saved copies.
- `tool-call-cap-experiment.mjs`: one web and one X query posted straight to the Responses
  endpoint with `max_tool_calls`, `parallel_tool_calls` and `max_turns` variants
  (`--only web|x --ids a,b --repeat N`). Result: `max_tool_calls` is ignored by api.x.ai and by
  relays; `parallel_tool_calls: false` gives one call per turn; the model matters more than
  either knob.
- `search-budget-eval.mjs`: questions answered by a pi agent under three variants of the
  SKILL.md search budget line (`one` search, about `two`, `gap` rule with no number).
  `--set facts` has twelve current-fact questions (single fact, two-part, multi-hop, doc detail);
  `--set research` has six multi-part ones (several versions at once, release-note contents,
  a tool landscape). `--models a,b` repeats every cell per pi model. Each run gets its own skill
  copy, session dir and `GROK_OUTPUT_DIR`, so searches and Grok cost are counted per run; pi runs
  in `--mode json` and is stopped on `agent_settled`, since with the xai provider it does not
  exit by itself. Answers are scored with regexes against gold taken from official sources on
  2026-10-02, which go stale as projects release. `--score-only DIR` rescores a finished run.
  `--conditions dot,bare,basedir,basedir-short` instead compares how the command examples name
  the scripts (`./scripts/`, `scripts/`, `{baseDir}/scripts/` with a long or a one-clause
  definition); the summary counts exit-127 calls, i.e. scripts run from the wrong directory.

## Grader amendments

The question set, truth snapshots, and official URLs stay frozen. Scoring regexes may gain
synonym translations when a semantically correct answer is rejected on vocabulary alone:

- 2026-08-10: the `rust` criterion for "symbol mangling v0" also accepts 修饰 (the
  `rust-vs-deno` criterion already did); a correct answer phrased as 符号修饰 had scored as a miss.
