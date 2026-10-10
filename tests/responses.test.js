#!/usr/bin/env node
import assert from "node:assert/strict";
import { inferApiProvider } from "../scripts/lib/config.js";
import { buildResponsesBody, parseGrokResponses } from "../scripts/lib/grok-responses.js";

const baseOptions = {
  platform: "",
  model: "grok-4-fast",
  maxTurns: 1,
  reasoningEffort: "low",
  allowedDomains: [],
  excludedDomains: [],
  searchSource: "web",
  allowedXHandles: [],
  excludedXHandles: [],
  xFromDate: "",
  xToDate: "",
  xImageUnderstanding: false,
  xVideoUnderstanding: false,
  openRouterEngine: "auto",
};

assert.equal(inferApiProvider("https://openrouter.ai/api/v1"), "openrouter");
assert.equal(inferApiProvider("https://api.x.ai/v1"), "xai");
assert.equal(inferApiProvider("https://example.com/v1"), "openai-compatible");
const directBody = buildResponsesBody(
  "latest docs",
  {
    ...baseOptions,
    maxTurns: 2,
    reasoningEffort: "medium",
    allowedDomains: ["docs.x.ai", "openai.com"],
    searchSource: "both",
    allowedXHandles: ["xai", "OpenAI"],
  },
  { apiProvider: "xai" }
);
assert.equal(directBody.model, "grok-4-fast");
assert.equal(directBody.max_turns, 2);
assert.equal(directBody.reasoning.effort, "medium");
assert.equal(directBody.stream, false);
assert.deepEqual(directBody.tools, [
  { type: "web_search", filters: { allowed_domains: ["docs.x.ai", "openai.com"] } },
  { type: "x_search", allowed_x_handles: ["xai", "OpenAI"] },
]);
// The base prompt stays the first system message so it remains a cache prefix.
assert.equal(directBody.input.length, 3);
assert.equal(directBody.input[0].role, "system");
assert.equal(directBody.input[1].role, "system");
assert.match(directBody.input[1].content, /X \(Twitter\) evidence/);
assert.equal(directBody.input[2].role, "user");

// Caller instructions go after the query in the user message; system messages are untouched.
const instructedBody = buildResponsesBody(
  "latest docs",
  { ...baseOptions, instructions: "Return only official changelog links. Answer in Chinese." },
  { apiProvider: "xai" }
);
assert.equal(instructedBody.input.length, 2);
assert.equal(instructedBody.input[0].content, directBody.input[0].content);
assert.match(instructedBody.input[1].content, /\n# Search query\nlatest docs\n\n# Instructions from the caller\nReturn only official changelog links\. Answer in Chinese\.\n$/);
// Without instructions the query stays bare, exactly as before.
assert.equal(/# Search query/.test(directBody.input[2].content), false);
assert.equal(directBody.input[2].content.endsWith("latest docs"), true);
const plainBody = buildResponsesBody("latest docs", { ...baseOptions, instructions: "   " }, { apiProvider: "xai" });
assert.equal(/Instructions from the caller/.test(plainBody.input[1].content), false);

const webOnlyBody = buildResponsesBody("latest docs", baseOptions, { apiProvider: "xai" });
assert.deepEqual(webOnlyBody.tools, [{ type: "web_search" }]);
assert.equal(webOnlyBody.input.length, 2);
assert.equal(webOnlyBody.input.every((message) => !/X \(Twitter\) evidence/.test(message.content)), true);

const xOnlyBody = buildResponsesBody(
  "what is X saying",
  {
    ...baseOptions,
    searchSource: "x",
    excludedXHandles: ["spam_account"],
    xFromDate: "2026-08-01",
    xToDate: "2026-08-16",
    xImageUnderstanding: true,
    xVideoUnderstanding: true,
  },
  { apiProvider: "xai" }
);
assert.deepEqual(xOnlyBody.tools, [
  {
    type: "x_search",
    excluded_x_handles: ["spam_account"],
    from_date: "2026-08-01",
    to_date: "2026-08-16",
    enable_image_understanding: true,
    enable_video_understanding: true,
  },
]);

const nonReasoningBody = buildResponsesBody(
  "latest docs",
  { ...baseOptions, model: "grok-4.20-0309-non-reasoning" },
  { apiProvider: "xai" }
);
assert.equal(Object.hasOwn(nonReasoningBody, "reasoning"), false);

const fixedReasoningBody = buildResponsesBody(
  "latest docs",
  { ...baseOptions, model: "grok-4.20-0309-reasoning" },
  { apiProvider: "xai" }
);
assert.equal(Object.hasOwn(fixedReasoningBody, "reasoning"), false);

const multiAgentBody = buildResponsesBody(
  "latest docs",
  { ...baseOptions, model: "grok-4.20-multi-agent-0309" },
  { apiProvider: "xai" }
);
assert.equal(multiAgentBody.reasoning.effort, "low");

const openRouterBody = buildResponsesBody(
  "latest docs",
  {
    ...baseOptions,
    model: "x-ai/grok-4.1-fast",
    excludedDomains: ["reddit.com"],
    searchSource: "both",
    excludedXHandles: ["noisy_account"],
    xFromDate: "2026-01-01",
    openRouterEngine: "exa",
  },
  { apiProvider: "openrouter" }
);
assert.equal(openRouterBody.model, "x-ai/grok-4.1-fast");
assert.equal(openRouterBody.model.includes(":online"), false);
assert.equal(Object.hasOwn(openRouterBody, "max_turns"), false);
assert.deepEqual(openRouterBody.tools, [
  {
    type: "openrouter:web_search",
    parameters: {
      engine: "exa",
      max_results: 5,
      max_total_results: 10,
      excluded_domains: ["reddit.com"],
    },
  },
]);
assert.deepEqual(openRouterBody.x_search_filter, {
  excluded_x_handles: ["noisy_account"],
  from_date: "2026-01-01",
});

const parsed = parseGrokResponses({
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Answer with citations.",
          annotations: [{ type: "url_citation", url: "https://Example.com/a/#section", title: "Official A" }],
        },
      ],
    },
    {
      type: "web_search_call",
      status: "completed",
      action: {
        sources: [
          { url: "https://example.com/a", title: "Duplicate searched source", snippet: "duplicate" },
          { url: "https://example.com/b", title: "Searched B", snippet: "searched snippet" },
        ],
      },
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cost_in_usd_ticks: 123456,
  },
});

assert.equal(parsed.text, "Answer with citations.");
assert.equal(parsed.sources.length, 2);
assert.deepEqual(parsed.sources[0], {
  provider: "grok-responses",
  source_type: "citation",
  tool: "web_search",
  url: "https://example.com/a",
  title: "Official A",
  snippet: "duplicate",
});
assert.deepEqual(parsed.sources[1], {
  provider: "grok-responses",
  source_type: "searched",
  tool: "web_search",
  url: "https://example.com/b",
  title: "Searched B",
  snippet: "searched snippet",
});
assert.equal(parsed.diagnostics.responses_web_search_calls, 1);
assert.equal(parsed.diagnostics.responses_x_search_calls, 0);
assert.equal(parsed.diagnostics.cost_in_usd_ticks, 123456);
assert.equal(parsed.diagnostics.cost_usd, 0.0000123456);
assert.deepEqual(parsed.diagnostics.warnings, []);

const openRouterParsed = parseGrokResponses(
  {
    output: [
      {
        type: "message",
        message: {
          content: [
            {
              type: "output_text",
              text: "OpenRouter answer.",
              annotations: [{ url: "https://docs.example.com/page", title: "Docs" }],
            },
          ],
        },
      },
    ],
    citations: ["https://top.example.com/ref"],
    usage: { cost_usd: 0.25 },
  },
  { defaultTool: "openrouter:web_search" }
);

assert.equal(openRouterParsed.text, "OpenRouter answer.");
assert.deepEqual(
  openRouterParsed.sources.map((source) => ({ source_type: source.source_type, tool: source.tool, url: source.url })),
  [
    { source_type: "citation", tool: "openrouter:web_search", url: "https://docs.example.com/page" },
    { source_type: "citation", tool: "openrouter:web_search", url: "https://top.example.com/ref" },
  ]
);
assert.equal(openRouterParsed.diagnostics.cost_usd, 0.25);

const xPayload = {
  output: [
    {
      type: "x_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "from:xai grok 4.5",
        sources: [{ type: "url", url: "https://x.com/xai/status/123" }],
      },
    },
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url: "https://docs.x.ai/developers/grok-4-5" },
    },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "X-backed answer.",
          annotations: [{ type: "url_citation", url: "https://x.com/xai/status/123", title: "1" }],
        },
      ],
    },
  ],
};

const xParsed = parseGrokResponses(xPayload, { xEnabled: true });

// The X citation plus the page Grok opened (open_page URLs are evidence even when no
// search listing carried them).
assert.equal(xParsed.sources.length, 2);
assert.equal(xParsed.sources[0].tool, "x_search");
// The citation title is only the inline marker; the handle comes from the URL instead.
assert.equal(xParsed.sources[0].title, "@xai");
assert.equal(xParsed.sources[0].x_handle, "xai");
assert.equal(xParsed.sources[0].x_post_id, "123");
assert.deepEqual(xParsed.sources[1], {
  provider: "grok-responses",
  source_type: "searched",
  tool: "web_search",
  url: "https://docs.x.ai/developers/grok-4-5",
  opened: true,
});
assert.equal(xParsed.diagnostics.responses_web_search_calls, 1);
assert.equal(xParsed.diagnostics.responses_x_search_calls, 1);
assert.equal(xParsed.diagnostics.responses_tool_call_total, 2);
assert.deepEqual(xParsed.diagnostics.responses_tool_calls, [
  {
    tool: "x_search",
    type: "x_search_call",
    status: "completed",
    action_type: "search",
    query: "from:xai grok 4.5",
    source_count: 1,
  },
  {
    tool: "web_search",
    type: "web_search_call",
    status: "completed",
    action_type: "open_page",
    url: "https://docs.x.ai/developers/grok-4-5",
    source_count: 0,
  },
]);

// Under --source web no x_search tool is mounted, so an x.com citation web search found
// must not be relabeled as an X search that never ran.
const webOnlyXCitation = parseGrokResponses(xPayload, { xEnabled: false });
assert.equal(webOnlyXCitation.sources[0].tool, "web_search");
// The URL-derived attribution is still useful and stays regardless of the mounted tool.
assert.equal(webOnlyXCitation.sources[0].x_handle, "xai");

// Relays that bill x_search without emitting x_search_call items in output[]: usage wins.
const usageCountedParsed = parseGrokResponses({
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Answer from X.",
          annotations: [
            { type: "url_citation", url: "https://x.com/kunchenguid/status/2087942296721559607", title: "1" },
            { type: "url_citation", url: "https://x.com/i/status/2087942296721559608", title: "2" },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 8 },
  },
}, { xEnabled: true });

assert.equal(usageCountedParsed.diagnostics.responses_x_search_calls, 8);
assert.equal(usageCountedParsed.diagnostics.responses_web_search_calls, 0);
assert.equal(usageCountedParsed.diagnostics.responses_tool_call_total, 8);
assert.equal(usageCountedParsed.diagnostics.responses_tool_calls.length, 0);
assert.deepEqual(usageCountedParsed.diagnostics.responses_tool_call_counts, {
  upstream: { web: 0, x: 8 },
  trace: { web: 0, x: 0 },
});
assert.equal(usageCountedParsed.sources[0].title, "@kunchenguid");
assert.equal(usageCountedParsed.sources[0].x_handle, "kunchenguid");
// x.com/i/status/... carries no handle, so the marker title is dropped rather than kept.
assert.equal(usageCountedParsed.sources[1].x_post_id, "2087942296721559608");
assert.equal(Object.hasOwn(usageCountedParsed.sources[1], "x_handle"), false);
assert.equal(Object.hasOwn(usageCountedParsed.sources[1], "title"), false);

// The mirror relay bug: usage reports the field zeroed out while output[] shows the calls.
// Neither source alone is trustworthy, so the higher per-tool count wins.
const zeroedUsageParsed = parseGrokResponses({
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "a" } },
    { type: "web_search_call", status: "completed", action: { type: "search", query: "b" } },
    { type: "message", content: [{ type: "output_text", text: "Answer." }] },
  ],
  usage: { server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 0 } },
});
assert.equal(zeroedUsageParsed.diagnostics.responses_web_search_calls, 2);
assert.equal(zeroedUsageParsed.diagnostics.responses_tool_call_total, 2);
assert.deepEqual(zeroedUsageParsed.diagnostics.responses_tool_call_counts, {
  upstream: { web: 0, x: 0 },
  trace: { web: 2, x: 0 },
});

// No usage block at all: upstream is null rather than a fake zero.
const noUsageParsed = parseGrokResponses({
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "a" } },
    { type: "message", content: [{ type: "output_text", text: "Answer." }] },
  ],
});
assert.deepEqual(noUsageParsed.diagnostics.responses_tool_call_counts, { upstream: null, trace: { web: 1, x: 0 } });

// A failed call read nothing and usage leaves it out, so it does not count and does not mark
// its URL opened. Seen live 2026-10-04: Grok guessed a xinhuanet URL, open_page failed, and
// the card still ranked above the Tavily result that held the answer.
const failedCallParsed = parseGrokResponses({
  output: [
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "a", sources: [{ url: "https://www.gov.cn/listed", title: "Listed" }] },
    },
    { type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://www.xinhuanet.com/guessed.htm" } },
    { type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://www.gov.cn/listed" } },
    { type: "web_search_call", status: "failed", action: { type: "find_in_page", url: "https://www.gov.cn/listed", pattern: "x" } },
    { type: "message", content: [{ type: "output_text", text: "Answer." }] },
  ],
  usage: { server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 0 } },
});
assert.equal(failedCallParsed.diagnostics.responses_web_search_calls, 1);
assert.deepEqual(failedCallParsed.diagnostics.responses_tool_call_counts.trace, { web: 1, x: 0 });
assert.deepEqual(
  failedCallParsed.sources.map((source) => [source.url, source.opened === true]),
  [["https://www.gov.cn/listed", false]]
);
assert.deepEqual(
  failedCallParsed.diagnostics.responses_tool_calls.map((call) => call.status),
  ["completed", "failed", "failed", "failed"]
);

// A marker title ("1") on the citation is a placeholder: the real title from the search
// listing replaces it, and a page Grok opened is marked as such on the existing card.
const markerParsed = parseGrokResponses({
  output: [
    {
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "pi context window",
        sources: [
          { url: "https://github.com/o/r/issues/1", title: "Real issue title", snippet: "real snippet" },
          { url: "https://github.com/o/r/issues/2", title: "Second issue" },
        ],
      },
    },
    { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://github.com/o/r/issues/2" } },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "answer [1]",
          annotations: [{ type: "url_citation", url: "https://github.com/o/r/issues/1", title: "1" }],
        },
      ],
    },
  ],
});
assert.equal(markerParsed.sources[0].source_type, "citation");
assert.equal(markerParsed.sources[0].title, "Real issue title");
assert.equal(markerParsed.sources[0].snippet, "real snippet");
assert.equal(Object.hasOwn(markerParsed.sources[0], "opened"), false);
assert.equal(markerParsed.sources[1].title, "Second issue");
assert.equal(markerParsed.sources[1].opened, true);
assert.equal(markerParsed.sources.length, 2);
// Without a real title anywhere, the marker is dropped: a footnote number is not a title,
// and the agent reads an absent field better than a misleading one. (Seen live on 2026-09-08:
// a relay's web_search listed 20 GitHub URLs with no titles, so the citation showed as "1".)
const markerOnly = parseGrokResponses({
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: "x", annotations: [{ type: "url_citation", url: "https://example.com/p", title: "3" }] }],
    },
  ],
});
assert.equal(Object.hasOwn(markerOnly.sources[0], "title"), false);
assert.equal(markerOnly.sources[0].source_type, "citation");

// A relay that passes xAI's x_search through as its underlying tools: custom_tool_call items
// named x_keyword_search / x_thread_fetch with JSON-string arguments (seen 2026-09-08). They
// count as x_search calls, by_action reads like the web side, and the query is recovered.
const customXParsed = parseGrokResponses(
  {
    model: "grok-4.5",
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: "I'll search X for firsthand posts about Grok 4.6 in coding agents." }] },
      { type: "custom_tool_call", name: "x_keyword_search", status: "completed", input: JSON.stringify({ query: "Grok 4.6 cursor", limit: "10", mode: "Latest" }) },
      { type: "custom_tool_call", name: "x_thread_fetch", status: "completed", input: JSON.stringify({ post_id: "2095712849473741107" }) },
      { type: "custom_tool_call", name: "x_semantic_search", status: "completed", input: "not json" },
      { type: "message", content: [{ type: "output_text", text: "Pulling a few more threads." }] },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "## Firsthand posts\n1. **@smalldozes** — 2026-09-04 — switched to cursor + grok 4.6.",
            annotations: [{ type: "url_citation", url: "https://x.com/smalldozes/status/2095712849473741107", title: "1" }],
          },
        ],
      },
    ],
    usage: { server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 3 } },
  },
  { defaultTool: "x_search", xEnabled: true, requestedModel: "grok-4.5" }
);
assert.equal(customXParsed.diagnostics.responses_x_search_calls, 3);
assert.deepEqual(customXParsed.diagnostics.responses_tool_call_counts, { upstream: { web: 0, x: 3 }, trace: { web: 0, x: 3 } });
assert.deepEqual(
  customXParsed.diagnostics.responses_tool_calls.map((call) => [call.tool, call.action_type, call.query ?? null, call.post_id ?? null]),
  [
    ["x_search", "keyword_search", "Grok 4.6 cursor", null],
    ["x_search", "thread_fetch", null, "2095712849473741107"],
    ["x_search", "semantic_search", null, null],
  ]
);
// Narration between tool calls is dropped; the final message is the answer.
assert.equal(customXParsed.text.startsWith("## Firsthand posts"), true);
assert.equal(/I'll search X|Pulling a few/.test(customXParsed.text), false);
assert.equal(customXParsed.diagnostics.responses_model, "grok-4.5");
assert.equal(customXParsed.diagnostics.warnings.some((w) => /served model/.test(w)), false);

// A long earlier message or one carrying citations is not narration and stays.
const twoPartParsed = parseGrokResponses({
  output: [
    { type: "message", content: [{ type: "output_text", text: "Part one. " + "x".repeat(300) }] },
    { type: "message", content: [{ type: "output_text", text: "Part two." }] },
  ],
});
assert.equal(twoPartParsed.text.startsWith("Part one."), true);
assert.equal(twoPartParsed.text.endsWith("Part two."), true);
const singleParsed = parseGrokResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "Short only." }] }] });
assert.equal(singleParsed.text, "Short only.");

// The relay silently served another model: say so (micuapi returned grok-4.5-build for
// every grok-4.5 request on 2026-09-08, at two to three times the tool calls).
const substituted = parseGrokResponses(
  { model: "grok-4.5-build", output: [{ type: "message", content: [{ type: "output_text", text: "Answer." }] }] },
  { requestedModel: "grok-4.5" }
);
assert.equal(substituted.diagnostics.responses_model, "grok-4.5-build");
assert.equal(substituted.diagnostics.warnings.some((w) => /served model "grok-4\.5-build" for requested "grok-4\.5"/.test(w)), true);

// parallel_tool_calls is only sent when the caller decided.
assert.equal(Object.hasOwn(buildResponsesBody("q", baseOptions, { apiProvider: "xai" }), "parallel_tool_calls"), false);
assert.equal(buildResponsesBody("q", { ...baseOptions, parallelToolCalls: false }, { apiProvider: "xai" }).parallel_tool_calls, false);
assert.equal(buildResponsesBody("q", { ...baseOptions, parallelToolCalls: true }, { apiProvider: "xai" }).parallel_tool_calls, true);
assert.equal(buildResponsesBody("q", { ...baseOptions, parallelToolCalls: false }, { apiProvider: "openrouter" }).parallel_tool_calls, false);

// A citation whose title is its own URL (seen on a relay 2026-09-08) gets no title, and an X
// URL without a handle then carries only x_post_id.
const urlTitled = parseGrokResponses({
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "a [1] b [2]",
          annotations: [
            { type: "url_citation", url: "https://x.com/i/status/2097015220749074540", title: "https://x.com/i/status/2097015220749074540" },
            { type: "url_citation", url: "https://example.com/post", title: "https://example.com/post" },
          ],
        },
      ],
    },
  ],
});
assert.equal(Object.hasOwn(urlTitled.sources[0], "title"), false);
assert.equal(urlTitled.sources[0].x_post_id, "2097015220749074540");
assert.equal(Object.hasOwn(urlTitled.sources[1], "title"), false);

// Without an inline citation, xAI lists every page its searches returned as zero-span
// annotations titled with their own URL (api.x.ai and two relays, 2026-10-10). That listing
// is not a citation; the links the answer writes are, in reading order. URLs in code are
// endpoints the answer reports, and a "web:58" label only numbers the link.
const listing = (url) => ({ type: "url_citation", url, start_index: 0, end_index: 0, title: url });
const linkedParsed = parseGrokResponses({
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: [
            "Prices are on [**Pay as You Go**](https://platform.minimax.io/docs/guides/pricing-paygo) and the CN page https://platform.minimax.cn/docs/guides/pricing-paygo。",
            "The base URL is `https://api.minimax.io/anthropic`; see ([web:58](https://example.com/notes)) and [[1]](https://example.com/cited).",
            "```\ncurl https://api.minimax.io/v1/models\n```",
          ].join("\n\n"),
          annotations: [
            { type: "url_citation", url: "https://example.com/cited", start_index: 180, end_index: 210, title: "1" },
            listing("https://example.com/listed"),
            listing("https://platform.minimax.io/docs/guides/pricing-paygo"),
          ],
        },
      ],
    },
  ],
});
assert.deepEqual(
  linkedParsed.sources.map((source) => [source.source_type, source.url, source.title ?? null]),
  [
    ["citation", "https://example.com/cited", null],
    ["citation", "https://platform.minimax.io/docs/guides/pricing-paygo", "Pay as You Go"],
    ["citation", "https://platform.minimax.cn/docs/guides/pricing-paygo", null],
    ["citation", "https://example.com/notes", null],
    ["searched", "https://example.com/listed", null],
  ]
);

// grok-4.6 sometimes stops at its first inline citation; the answer then carries no link and
// only the listing. No card may claim to be cited, and a message whose only annotations are
// the listing is still narration.
const cutParsed = parseGrokResponses({
  output: [
    { type: "message", content: [{ type: "output_text", text: "Searching the docs.", annotations: [listing("https://a.example/1")] }] },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "An answer that stopped at its first citation.",
          annotations: [listing("https://a.example/1"), listing("https://a.example/2")],
        },
      ],
    },
  ],
});
assert.equal(cutParsed.text, "An answer that stopped at its first citation.");
assert.deepEqual(
  cutParsed.sources.map((source) => [source.source_type, source.url]),
  [
    ["searched", "https://a.example/1"],
    ["searched", "https://a.example/2"],
  ]
);

const missing = parseGrokResponses({});
assert.equal(missing.text, "");
assert.equal(missing.sources.length, 0);
assert.equal(missing.diagnostics.warnings.length >= 1, true);

console.log("responses fixtures ok");
