# Search Planning

Use this reference only for complex or high-stakes web tasks. Keep simple URL fetches and straightforward latest-fact checks direct.

## When To Plan

Plan first when:

- The user asks a multi-part question.
- The answer depends on current facts, regulations, prices, releases, or schedules.
- Sources may disagree and need comparison.
- You need both site discovery and page content.

Skip planning when:

- The user gave one URL and asked for its content.
- The user asked for a simple current lookup that one search can answer.

## Minimal Workflow

1. Restate the information need in one concrete sentence.
2. Split into independent sub-questions only when needed.
3. Pick the cheapest script per sub-question:
   - `map.js` for candidate URLs on a known site.
   - `fetch.js` for known URLs.
   - `search.js` for unknown URLs or current facts.
4. Run the fewest commands that can answer the question.
5. Prefer primary or official sources when accuracy matters.
6. If results conflict, fetch the primary pages and explain the conflict.

## Source Hygiene

- Treat `search.js --extra N` sources as supplemental references. They did not necessarily influence Grok's answer.
- Treat Direct Fetch output as best-effort text extraction, not a high-fidelity browser render.
- Treat Direct Map as candidate URL discovery only.
- Use `warnings`, `tried`, `extra_tried`, `provider`, and `full_output_path` to decide whether another command is needed.

## Avoid Over-Searching

Stop searching when the evidence is enough to answer the user. Do not run map, fetch, and search automatically for every task. Each extra command should reduce uncertainty or provide a source the current result lacks.
