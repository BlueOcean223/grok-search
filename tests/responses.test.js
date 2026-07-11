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
  includeXSearch: false,
  allowedXHandles: [],
  excludedXHandles: [],
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
    includeXSearch: true,
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
    includeXSearch: true,
    excludedXHandles: ["noisy_account"],
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
assert.deepEqual(openRouterBody.x_search_filter, { excluded_x_handles: ["noisy_account"] });

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

const xParsed = parseGrokResponses({
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
});

assert.equal(xParsed.sources.length, 1);
assert.equal(xParsed.sources[0].tool, "x_search");
assert.equal(xParsed.diagnostics.responses_web_search_calls, 1);
assert.equal(xParsed.diagnostics.responses_x_search_calls, 1);
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

const missing = parseGrokResponses({});
assert.equal(missing.text, "");
assert.equal(missing.sources.length, 0);
assert.equal(missing.diagnostics.warnings.length >= 1, true);

console.log("responses fixtures ok");
