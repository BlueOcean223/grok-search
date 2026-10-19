# Search Planning

Use this reference for complex or high-stakes web tasks. Direct URL fetches and single-shot latest-fact checks do not need a plan.

## When To Plan

Plan first when any of these apply:

- The question has multiple independent parts.
- The answer depends on current facts that may have moved (regulations, prices, releases, schedules).
- Sources may disagree and you have to reconcile them.
- The task needs both site discovery (map) and page content (fetch).

Skip planning when:

- The user gave a URL and asked what is on it — go straight to `fetch.js`.
- A single search query can answer it — go straight to `search.js`.
- The user wants a pointer to a known doc — answer from memory or one fetch.

## Minimal Workflow

1. Restate the information need in one concrete sentence. If you cannot, ask the user before searching.
2. Split into independent sub-questions only when one query cannot cover them.
3. Pick the cheapest script per sub-question by what is already known:
   - URL known → `fetch.js`.
   - Site known, URL not → `map.js`, then `fetch.js` on the chosen URL.
   - Neither known, or the question is "what is current" → `search.js`.
4. Run the fewest commands that can answer the question. Run independent commands in parallel, not sequentially.
5. Prefer primary or official sources when accuracy matters (vendor docs, standards bodies, release notes, official changelogs).
6. If results conflict, fetch each primary page and surface the conflict to the user instead of silently picking a side.

## Timeline Questions

"Is it available now", "did they change the default", "does this still fail": the answer has a date, and sources from different dates are not in conflict, they are in sequence.

- Search the recent window first (`--x-from-date` 60–90 days back for X; add the current month or version to the web question). Widen only when the recent window is empty.
- Use older material to explain how things got here, never to describe the present. An issue closed in March does not say what shipped in August.
- When two sources disagree, write both with their dates and who said them (handle or organization), say which is newer, and leave the reconciliation visible to the user instead of picking one.
- Tag each decisive quote with date, model or product version, client, and login method when those exist. A large share of apparent contradictions are two different setups.

## Source Hygiene

- Treat `searched` cards as leads, not citations: Grok only saw them in a search listing. A card with `opened: true` was read. Verify with `fetch.js` if accuracy matters.
- Treat Direct Fetch output as best-effort text extraction, not a full browser render. Tables, scripts, and JS-rendered regions may be missing.
- Treat Direct Map output as candidate URLs only, not a complete sitemap.
- On every result, scan `diagnostics.warnings`, `diagnostics.provider_attempts`, `diagnostics.provider`, and `content.full_path` / `answer.full_path` before deciding whether another command is needed.
- If two sources disagree and both look authoritative, fetch each, quote the relevant lines, and report the conflict.

## Stop Conditions

Stop as soon as the evidence answers the user. Every extra command should either reduce a specific uncertainty or supply a source the current result lacks. If you are about to run another command "just to be thorough" without a named gap to close, stop and answer. If two queries have already covered the same gap, a third phrasing will not close it: fetch the best URL you have or report the gap.
