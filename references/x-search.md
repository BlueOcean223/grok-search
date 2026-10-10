# X Search And X Posts

Read this when a question involves X (Twitter): choosing `--source`, filtering handles or dates, reading X cards, or fetching a post.

## Choosing The Source

- `--source x` — the question is about X itself: reactions, sentiment, what people are saying, what a named account posted, a thread, or a claim that is only circulating on X. Only `x_search` is mounted, so Grok cannot fall back to the web.
- `--source both` — a current event where reaction and reporting both matter, or a fast-moving topic where web coverage may lag X by hours. Grok decides per call.
- Default (omit `--source`) — documentation, releases, versions, prices, specs, how-to. X is not a source for these.

X search bills $5 per 1k calls, the same as web search. `diagnostics.responses_x_search_calls` reports what a run actually used; `diagnostics.search_budget` puts that next to the prompt's advisory budget (about 6 searches total, at most about 4 on X). The budget is advice to the model, not a cap: `max_turns` bounds agentic turns, one turn can hold several searches, and it is a hard cap for X search only — web search runs past it. Two knobs were tested on 2026-09-08. `max_tool_calls` is ignored by `api.x.ai` itself (a cap of 1 still ran 4 calls) and by every relay seen. `parallel_tool_calls: false` works against `api.x.ai` and on relays that pass it through: one call per turn, so `max_turns` becomes a hard cap. Savings scale with how many parallel calls Grok would otherwise fire: grok-4.5 via a relay went from 7–14 calls to 3 at a third of the cost with the same handles and dates; grok-4.6, direct or via the same relay, runs 3–4 calls on its own and gained nothing. Add it when `responses_tool_calls.total` is above 6. One relay ignored it (echoed `true`). The model is the bigger lever: on the same relay and question grok-4.6 made a third to a quarter of grok-4.5's calls. Send it with `--responses-parallel-tool-calls false` (or config `responsesParallelToolCalls: false`); `diagnostics.responses_tool_calls.total` shows whether it took. Fewer searches from your side remains the other lever.

## Filters

```bash
{baseDir}/scripts/search.js --source x "what is X saying about the outage"
{baseDir}/scripts/search.js --source both "reaction to the release"
{baseDir}/scripts/search.js --source x --responses-allowed-x-handles xai,OpenAI "query"
{baseDir}/scripts/search.js --source x --x-from-date 2026-08-01 --x-to-date 2026-08-16 "query"
{baseDir}/scripts/search.js --source x --extra 4 "query"           # also run Tavily/Firecrawl (web only)
```

- `--responses-allowed-x-handles` and `--responses-excluded-x-handles` are mutually exclusive, max 20 each, and either one implies X search.
- `--x-from-date` / `--x-to-date` are `YYYY-MM-DD` and must be real calendar dates; either implies X search.
- `--x-images` / `--x-videos` analyze media inside posts and are billed as extra tokens. Enable them only when the question is about the media itself.
- The config file may already restrict handles or domains. Those restrictions hold: a flag can narrow them further, but asking for something they exclude fails with `RESPONSES_FILTER_FORBIDDEN` or `RESPONSES_FILTER_EMPTY` rather than silently widening the search.

## Timeline Questions

For "can I use this now", "is it open", "what is the current default": start with a `--x-from-date` 60–90 days back and widen only if the window is empty. Old GitHub issues and posts explain how a default came to be; they do not describe today. When two dates disagree, report both with their dates and say which is newer.

Before a second X search, name the specific gap it closes. Do not put the previous round's conclusion words ("useless", "broken", "fixed") into the query; they steer the search toward confirmation. For the same handle, change the gap, not the phrasing.

## Reading X Cards

- Cards carry `x_post_id` for every X post URL and `x_handle` when the URL names one, plus `tool: "x_search"` when X search was actually mounted. xAI's X search often cites `/i/status/<id>`, which names no handle (120 of 186 grok-4.6 X-search cards on record); when the answer links the same post with its handle, the two become one card with the handle, otherwise the handle is only in `answer.text`. Under `--source web`, an x.com card came from web search and is labeled as such.
- Some relays return X search as its underlying tools (`x_keyword_search`, `x_semantic_search`, `x_thread_fetch`, `x_user_search`); they are counted as `x_search` and `responses_tool_calls.by_action` shows them as `keyword_search`, `thread_fetch`, and so on. Other relays return no per-call items at all, so only the billed count is known.
- The card has no post text or date. Those live in `answer.text`, which attributes each X claim to its handle and date. Cite the handle, not a bare URL.
- Treat posts as personal statements: attribute each to its handle and date, keep claims separate from confirmations, and do not treat repetition across accounts as corroboration. When an official source exists, confirm the fact there and use X for reaction, timing, or first-hand experience.
- Tavily and Firecrawl extras never search X, so on `--source x` they are off by default (`diagnostics.options.extra_mode: "off-x-only"`). In the 2026-09-08 side-by-side all six of their results for an X question were unrelated web pages. `--extra N` forces them on; `--source both` keeps them on.

## Fetching A Post

Firecrawl bills an X post at about 30 credits (an ordinary page is 1). The keyless daily tier is exhausted after about three such fetches, and the exhaustion also takes down Firecrawl search for the rest of the day (see `references/providers.md`, cooldown).

- `--provider auto` with a URL that has both handle and post id: Direct runs first, whatever keys are configured, and succeeds only when the page names the handle (after X's redirect to the canonical handle), carries a date, and has non-boilerplate text. The result is the main post only. If validation fails, Tavily runs and then Firecrawl (X pages keep Tavily first: Firecrawl bills about 30 credits for one); if that is unavailable too, the Direct text is returned with a warning.
- Why Direct first even with keys (2026-09-08 side-by-side): Tavily is fast and free but returned one of three posts without any date and timed out on another; Firecrawl gives ISO timestamps, engagement counts and the thread, at about 30 credits and 10 seconds or more per post.
- Need the thread or replies: `{baseDir}/scripts/fetch.js --provider firecrawl <post-url>`, deliberately, once. A `credits_used >= 10` fetch adds a warning stating the cost.
- `/i/status/<id>` and `/i/web/status/<id>` URLs carry no handle and cannot be validated; they use the normal order.

When citing a post as decisive evidence, record its date, the model version, the client, and the login method the author used. Most contradictions between posts dissolve once those four are separated.
