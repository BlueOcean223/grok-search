# Scope Decisions

This file records first-version scope decisions so future changes do not treat deliberate exclusions as accidental gaps.

## Included

### `search.js --extra N`

Included in the first version.

Purpose:

- Add supplemental Tavily/Firecrawl source results to `sources`.
- Keep Grok's `answer` unchanged.
- Record provider attempts in `extra_tried`.

Constraints:

- Default is `--extra 0`.
- Extra sources are deduplicated by normalized URL.
- Extra sources are references only; they did not necessarily influence Grok's reasoning.

## Excluded

### Grok Fetch / `--llm-fallback`

Not included.

Reason:

- `fetch.js` should mean fetching page content, not asking an LLM to infer or paraphrase a URL.
- LLM-mediated fetch can omit, summarize, or hallucinate content.

If added later, it must be explicitly marked as LLM-mediated output and must not be presented as direct page extraction.

### Enhanced Local HTML Extraction

Not included.

Reason:

- High-quality extraction needs a parser/readability dependency.
- The first version stays zero-dependency.
- Direct Fetch is only a best-effort fallback for ordinary text/HTML pages.

### CLI Packaging

Not included.

Reason:

- The project is distributed as a pi skill with scripts.
- There is no `bin`, build step, or package manager requirement.

### Browser Rendering, Login, Cookies, Proxy, PDF Parsing

Not included.

Reason:

- These expand the project from lightweight web access into a crawler/browser stack.
- They require separate security, dependency, and product decisions.
