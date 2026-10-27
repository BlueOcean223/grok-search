---
name: grok-search
description: Use when the user explicitly asks to search the web, check latest/current facts, fetch a URL, or discover pages on a website. Do not use for local code search or stable offline knowledge unless the user asks for live web access.
---

# Grok Search

Node scripts for web search, URL fetch and site mapping. Run `npm install` once in `{baseDir}`, the directory of this SKILL.md.

## Choose The Script

- URL given → `scripts/fetch.js`.
- Site named, URL unknown → `scripts/map.js`, then `fetch.js` on the URLs you pick.
- Current/latest information, or URL unknown → `scripts/search.js`.
- Question about the user's local machine → inspect local files first; search only to interpret them.

Run the fewest commands that answer the question; run independent sub-questions in parallel. Do not chain map → fetch → search.

## Commands

```bash
node {baseDir}/scripts/search.js "the question, with what to return"
node {baseDir}/scripts/search.js --instructions "format, language, what to leave out" "the question"
node {baseDir}/scripts/search.js --responses-allowed-domains github.com "the question"
node {baseDir}/scripts/search.js --source x --x-from-date 2026-07-01 "what people say about ..."
node {baseDir}/scripts/fetch.js https://example.com        # a cut page ends with the --offset to continue from
node {baseDir}/scripts/map.js https://docs.example.com --limit 20
```

Query rules:

- Only Grok reads the query, so write it as the question you want answered, with the fields you need: "What is the latest stable Go release, the full version number and its release date?" `--instructions` is optional, for how to answer (format, language, "quote and date only, no advice, say if not found"). Do not send a bag of keywords like `GPT Codex 1M 272k context window`; Grok fills the gaps with invented background.
- No code-search operators (`repo:`, `path:`, `language:`). Scope with `--responses-allowed-domains`.
- One search per sub-question is usually enough; to check a claim, fetch its source instead of searching again. Search again only for a gap you can name. Do not carry the previous round's conclusion words into the new question; for the same X handle, change the gap, not the phrasing.

## Search Source

Default is web. `--source x` for what people are saying, a named account's posts, a thread, or a claim only circulating on X. `--source both` for a current event where reporting and reaction both matter. `--source x` cannot fall back to the web.

- For "is it available now / current state" questions, start with `--x-from-date` 60–90 days back; widen only if empty (`diagnostics.warnings` says when the window read no posts). Old issues explain history, not the present.
- X posts are personal statements: cite handle and date (both live in `answer.text`, not the card), keep claims separate from confirmations, confirm facts at the official source.
- Cost: when an X search reports `responses_tool_calls.total` above 6, add `--responses-parallel-tool-calls false` next time: one call per turn, so `max_turns` caps the count; below 6 it saves nothing.
- Handle filters, dates, media flags, card fields: `references/x-search.md`.

## Fetch Cost

- X posts: `auto` tries Direct first (free, main post with date). `--provider firecrawl` only for the thread or replies; about 30 credits per post.
- Fetch only evidence that would change the conclusion: one or two URLs per turn, a representative post or two for experience reports, never re-fetch text you have. Reddit and YouTube return shells from every provider. WeChat articles (`mp.weixin.qq.com`) need `--provider deepseek` or `--provider firecrawl`; the others get a verification page.
- The same URL again within 15 minutes comes from a local cache (no provider call); a different `--provider` or `--no-cache` fetches anew.
- When citing decisive evidence, record date, model version, client, and login method.

## Reading Results

Every script prints one JSON object, also on failure (non-zero exit, stderr line).

- `error`: read `error.message`, `error.code`, `diagnostics.provider_attempts`. Change something before retrying (query, `--provider`, `--model`). `DEADLINE_EXCEEDED`: the whole command hit its time budget (default 240s, `--deadline N`).
- A line starting with `[grok-search]` inside `content.text` or `answer.text` changes how to read it: the text was cut (the line says where the rest is), the page redirected to the site's home page, or the provider got no text. `diagnostics.warnings` repeats these and adds the rest: providers skipped (e.g. Firecrawl in cooldown) or failed, a relay serving another model than requested. `diagnostics.provider_attempts` lists each provider tried.
- Search: `answer.text`, then `sources.items` (up to 12 of Grok's sources, cited ones kept first, so a cited link may appear only in `answer.text`). `source_type` `citation` = used in the answer, `searched` = only listed; `opened: true` = Grok read the page. `sources.raw_path` always points to the run record (full list, answer, tool calls); read it in chunks only when the cards are not enough. Check `diagnostics.cost_usd` and `diagnostics.search_budget` (advisory budget vs. calls made).
- Fetch: `content.text`, up to `--max-chars` characters (default 12000) from `--offset` (default 0); `content.chars` counts page text only. A cut page ends with a `[grok-search]` line giving the next `--offset` and `content.full_path`: continue from there instead of raising `--max-chars`. stdout stays under 45KB whatever `--max-chars` says. Non-HTML files come back as served (JSON re-indented). `metadata` has title/author/published_at when the provider had them. `diagnostics.run_path` is the run record.
- Map: `urls`; fetch the few you need. A URL with a path maps that path and below, on that site only; map the site root for the whole site.

Provider order, proxy, cooldown, config errors: `references/providers.md`. Multi-part or conflicting research: `references/planning.md` first.
