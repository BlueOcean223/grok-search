#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  compactSource,
  hostMatchesDomain,
  isCitationMarker,
  isOffDomainExtra,
  mergeSources,
  parseXPostUrl,
  selectSources,
} from "../scripts/lib/sources.js";
import { inMapScope, mapScope, scopePattern } from "../scripts/lib/map-scope.js";

assert.deepEqual(parseXPostUrl("https://x.com/xai/status/1975607901571199086"), {
  x_handle: "xai",
  x_post_id: "1975607901571199086",
});
assert.deepEqual(parseXPostUrl("https://twitter.com/elonmusk/statuses/123?s=20"), { x_handle: "elonmusk", x_post_id: "123" });
assert.deepEqual(parseXPostUrl("https://mobile.x.com/xai/status/123"), { x_handle: "xai", x_post_id: "123" });
assert.deepEqual(parseXPostUrl("https://x.com/xai/status/123/photo/1"), { x_handle: "xai", x_post_id: "123" });
// X's own routes are not handles. Only /<handle>/status/<id> names an author, so the
// canonical /i/web/status/<id> form must not be attributed to "@web".
assert.deepEqual(parseXPostUrl("https://x.com/i/status/1975607901571199086"), { x_post_id: "1975607901571199086" });
assert.deepEqual(parseXPostUrl("https://x.com/i/web/status/1975607901571199086"), { x_post_id: "1975607901571199086" });
// Profile URLs from user search still yield attribution.
assert.deepEqual(parseXPostUrl("https://x.com/xai"), { x_handle: "xai" });
assert.equal(parseXPostUrl("https://x.com/about"), null);
assert.equal(parseXPostUrl("https://x.com/login"), null);
assert.equal(parseXPostUrl("https://x.com/i/user/1912644073896206336"), null);
assert.equal(parseXPostUrl("https://x.com/xai/status/not-a-number"), null);
assert.equal(parseXPostUrl("https://example.com/xai/status/123"), null);
assert.equal(parseXPostUrl("https://notx.com/xai/status/123"), null);
assert.equal(parseXPostUrl(""), null);

const xCompacted = compactSource(
  { provider: "grok-responses", url: "https://x.com/xai/status/123", title: "@xai", x_handle: "xai", x_post_id: "123" },
  { sourceChars: 400 }
);
assert.deepEqual(xCompacted, {
  provider: "grok-responses",
  url: "https://x.com/xai/status/123",
  title: "@xai",
  x_handle: "xai",
  x_post_id: "123",
});

assert.deepEqual(
  mergeSources([{ url: "https://A.example/path/" }], [{ url: "https://a.example/path#section" }, { url: "https://b.example/" }]).map(
    (source) => source.url
  ),
  ["https://A.example/path/", "https://b.example/"]
);

// A duplicate URL fills in what the first record lacks: a marker title gives way to a real
// one, the description becomes the snippet, and the contributing provider is recorded.
const mergedCitation = mergeSources(
  [{ provider: "grok-responses", source_type: "citation", url: "https://example.com/post", title: "1" }],
  [{ provider: "firecrawl", url: "https://example.com/post/", title: "Great Post Title", description: "A useful description", score: 0.5 }]
);
assert.deepEqual(mergedCitation, [
  {
    provider: "grok-responses",
    source_type: "citation",
    url: "https://example.com/post",
    title: "Great Post Title",
    snippet: "A useful description",
    score: 0.5,
    merged_from: ["firecrawl"],
    list_ranks: { grok: 0, firecrawl: 0 },
  },
]);
// Existing real values are never overwritten, and an identical duplicate leaves no trace in
// merged_from. list_ranks still records that Tavily returned the URL, for the card ranking.
const keptTitle = mergeSources(
  [{ provider: "grok-responses", source_type: "citation", url: "https://example.com/a", title: "Original", snippet: "kept" }],
  [
    { provider: "tavily", url: "https://example.com/other" },
    { provider: "tavily", url: "https://example.com/a", title: "Other", description: "ignored" },
  ]
);
assert.equal(keptTitle[0].title, "Original");
assert.equal(keptTitle[0].snippet, "kept");
assert.equal(Object.hasOwn(keptTitle[0], "merged_from"), false);
assert.deepEqual(keptTitle[0].list_ranks, { grok: 0, tavily: 1 });
assert.equal(Object.hasOwn(compactSource(keptTitle[0]), "list_ranks"), false);
// One X post under two URL forms is one card: xAI's /i/status/<id> citation names no author,
// the answer's /<handle>/status/<id> link does, and the handle lands on the merged card.
const xMerged = mergeSources([
  { provider: "grok-responses", source_type: "citation", tool: "x_search", url: "https://x.com/i/status/2099958388230873165", x_post_id: "2099958388230873165" },
  { provider: "grok-responses", source_type: "citation", url: "https://x.com/trq212/status/2099958388230873165", title: "@trq212", x_handle: "trq212", x_post_id: "2099958388230873165" },
  { provider: "grok-responses", source_type: "citation", url: "https://x.com/trq212/status/1" },
  { provider: "grok-responses", source_type: "citation", url: "https://x.com/trq212" },
]);
assert.deepEqual(xMerged.map((source) => source.url), [
  "https://x.com/i/status/2099958388230873165",
  "https://x.com/trq212/status/1",
  "https://x.com/trq212",
]);
assert.equal(xMerged[0].x_handle, "trq212");
assert.equal(xMerged[0].title, "@trq212");
assert.equal(isCitationMarker("1"), true);
assert.equal(isCitationMarker("[12]"), true);
assert.equal(isCitationMarker("Issue #12"), false);

// Domain matching is by host suffix; extras outside the requested domains are recognised,
// Grok's own sources never are (its filter is applied server-side).
assert.equal(hostMatchesDomain("gist.github.com", "github.com"), true);
assert.equal(hostMatchesDomain("github.com", "github.com"), true);
assert.equal(hostMatchesDomain("notgithub.com", "github.com"), false);
assert.equal(hostMatchesDomain("raw.githubusercontent.com", "github.com"), false);
const filters = { allowedDomains: ["github.com"], excludedDomains: [] };
assert.equal(isOffDomainExtra({ provider: "firecrawl", url: "https://medium.com/p" }, filters), true);
assert.equal(isOffDomainExtra({ provider: "firecrawl", url: "https://github.com/o/r" }, filters), false);
assert.equal(isOffDomainExtra({ provider: "grok-responses", source_type: "searched", url: "https://medium.com/p" }, filters), false);
assert.equal(isOffDomainExtra({ provider: "tavily", url: "https://reddit.com/r/x" }, { allowedDomains: [], excludedDomains: ["reddit.com"] }), true);
assert.equal(isOffDomainExtra({ provider: "tavily", url: "https://medium.com/p" }, { allowedDomains: [], excludedDomains: [] }), false);

// compactSource carries the new flags through.
assert.deepEqual(
  compactSource({ provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true, merged_from: ["tavily"] }),
  { provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true, merged_from: ["tavily"] }
);

const compacted = compactSource(
  {
    provider: "tavily",
    title: "  Example  ",
    url: "https://example.com/a",
    description: "abcdefghijklmnopqrstuvwxyz",
    score: 0.91,
    published_date: "2026-06-22",
    raw_extra: { hidden: true },
  },
  { sourceChars: 10 }
);
assert.deepEqual(compacted, {
  provider: "tavily",
  url: "https://example.com/a",
  title: "Example",
  snippet: "abcdefghij",
  score: 0.91,
  published_date: "2026-06-22",
});
assert.equal(Object.hasOwn(compacted, "description"), false);
assert.equal(Object.hasOwn(compacted, "content"), false);

const noSnippet = compactSource({ provider: "grok", url: "https://example.com/b", description: "hidden" }, { sourceChars: 0 });
assert.deepEqual(noSnippet, { provider: "grok", url: "https://example.com/b" });

const rankedSources = [
  { url: "https://e.example/1", source_type: "searched" },
  { url: "https://e.example/2", provider: "tavily" },
  { url: "https://e.example/3", source_type: "citation" },
  { url: "https://e.example/4", source_type: "searched" },
];
const capped = selectSources(rankedSources, { maxSources: 2 });
// The first of Grok's list (the citation) and of Tavily's come before Grok's searched-only
// ones; the picked subset keeps the original order.
assert.deepEqual(
  capped.items.map((source) => source.url),
  ["https://e.example/2", "https://e.example/3"]
);
assert.equal(capped.total, 4);
assert.equal(capped.returned, 2);
assert.equal(capped.omitted, 2);

const uncapped = selectSources(rankedSources, { maxSources: 10 });
assert.equal(uncapped.returned, 4);
assert.equal(uncapped.omitted, 0);
assert.deepEqual(selectSources([], { maxSources: 5 }), { items: [], total: 0, returned: 0, omitted: 0 });

// Cards are picked by Reciprocal Rank Fusion: Grok's list and each extra provider's take turns,
// so extras show even when the citations alone would fill the cards.
const fused = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://g.example/cited-${n}`, source_type: "citation" })),
  { url: "https://t.example/1", provider: "tavily" },
  { url: "https://t.example/2", provider: "tavily" },
  { url: "https://f.example/1", provider: "firecrawl" },
];
assert.deepEqual(
  selectSources(fused, { maxSources: 6 }).items.map((source) => source.url),
  [
    "https://g.example/cited-1",
    "https://g.example/cited-2",
    "https://g.example/cited-3",
    "https://t.example/1",
    "https://t.example/2",
    "https://f.example/1",
  ]
);

// Grok's list runs cited > opened > searched whatever the input order, and a URL an extra
// provider also returned (merged into Grok's card) scores in both lists.
const grokOrder = mergeSources(
  [
    { url: "https://g.example/searched", source_type: "searched" },
    { url: "https://g.example/opened", source_type: "searched", opened: true },
    { url: "https://g.example/cited", source_type: "citation" },
    { url: "https://g.example/agreed", source_type: "searched" },
  ],
  [
    { url: "https://g.example/agreed", provider: "tavily" },
    { url: "https://t.example/1", provider: "tavily" },
  ]
);
assert.deepEqual(
  selectSources(grokOrder, { maxSources: 2 }).items.map((source) => source.url),
  ["https://g.example/cited", "https://g.example/agreed"]
);
assert.deepEqual(
  selectSources(grokOrder, { maxSources: 4 }).items.map((source) => source.url),
  ["https://g.example/opened", "https://g.example/cited", "https://g.example/agreed", "https://t.example/1"]
);

// The agreement counts whether or not the duplicate brought a field. Firecrawl's first result
// is Grok's twelfth citation with nothing new: it is shown (before list_ranks it was dropped
// while Firecrawl's second and third results were shown), and Grok's eleventh gives way.
const twelve = Array.from({ length: 12 }, (_, i) => ({
  provider: "grok-responses",
  source_type: "citation",
  url: `https://g.example/${i + 1}`,
  title: `G${i + 1}`,
  snippet: "s",
}));
const agreedPicked = selectSources(
  mergeSources(twelve, [
    { provider: "firecrawl", url: "https://g.example/12", title: "Same", description: "same" },
    { provider: "firecrawl", url: "https://f.example/2", title: "F2", description: "d" },
    { provider: "firecrawl", url: "https://f.example/3", title: "F3", description: "d" },
  ]),
  { maxSources: 12 }
).items.map((source) => source.url);
assert.equal(agreedPicked.includes("https://g.example/12"), true);
assert.equal(agreedPicked.includes("https://g.example/11"), false);

// An extra result outside the requested domains goes last, though it tops its provider's list.
const domainRanked = [
  { url: "https://github.com/cited", source_type: "citation" },
  { url: "https://github.com/searched", source_type: "searched" },
  { url: "https://gist.github.com/extra", provider: "tavily" },
  { url: "https://medium.com/off", provider: "firecrawl" },
];
const domainFilters = { allowedDomains: ["github.com"], excludedDomains: [] };
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 3, ...domainFilters }).items.map((source) => source.url),
  ["https://github.com/cited", "https://github.com/searched", "https://gist.github.com/extra"]
);
// Without filters it is an ordinary first result.
assert.deepEqual(
  selectSources(domainRanked, { maxSources: 3 }).items.map((source) => source.url),
  ["https://github.com/cited", "https://gist.github.com/extra", "https://medium.com/off"]
);

// A map stays under the URL's path; a URL that names a file maps its directory, since nothing
// is under a file. A version segment is a directory, not a file.
assert.equal(mapScope("https://a.example/"), "");
assert.equal(mapScope("https://a.example/docs/"), "/docs");
assert.equal(mapScope("https://a.example/docs/index.html"), "/docs");
assert.equal(mapScope("https://a.example/index.php?p=1"), "");
assert.equal(mapScope("https://a.example/docs/v1.2"), "/docs/v1.2");
assert.equal(inMapScope("https://a.example/docs/a", "a.example", "/docs"), true);
assert.equal(inMapScope("https://a.example/docs.html", "a.example", "/docs"), false);
assert.equal(inMapScope("https://www.a.example/docs/a", "a.example", "/docs"), false);
assert.equal(scopePattern("/docs"), "^/docs(/.*)?$");
assert.equal(scopePattern("/docs/v1.2"), "^/docs/v1\\.2(/.*)?$");

console.log("sources fixtures ok");
