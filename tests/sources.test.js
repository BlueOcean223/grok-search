#!/usr/bin/env node
import assert from "node:assert/strict";
import { compactSource, isCitationMarker, parseXPostUrl, selectSources, sourceCard, sourceKey } from "../scripts/lib/sources.js";
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

// One constructor for every card: URL normalized, blanks left out, X attribution from the URL,
// a marker or the URL itself dropped as a title.
assert.deepEqual(
  sourceCard(" https://Example.com/a/#top ", { provider: "grok-responses", source_type: "searched", title: " T ", snippet: "" }),
  { provider: "grok-responses", url: "https://example.com/a", source_type: "searched", title: "T" }
);
assert.deepEqual(
  sourceCard("https://x.com/i/status/5", { provider: "grok-responses", source_type: "citation", tool: "x_search", title: "1" }),
  { provider: "grok-responses", url: "https://x.com/i/status/5", source_type: "citation", tool: "x_search", x_post_id: "5" }
);
assert.deepEqual(
  sourceCard("https://x.com/xai/status/5", { provider: "grok-responses", source_type: "citation", title: "[2]", opened: true }),
  { provider: "grok-responses", url: "https://x.com/xai/status/5", source_type: "citation", opened: true, x_handle: "xai", x_post_id: "5", title: "@xai" }
);
assert.equal(sourceCard("https://x.com/xai/status/5", { provider: "grok-responses", title: "Real" }).title, "Real");
assert.equal(sourceCard("https://example.com/p", { provider: "grok-responses", title: "https://example.com/p" }).title, undefined);
assert.equal(sourceCard("", { provider: "grok-responses" }), null);
// The identity cards are deduplicated by: one key per X post whatever the URL form.
assert.equal(sourceKey("https://x.com/i/status/5"), sourceKey("https://x.com/xai/status/5/"));
assert.equal(sourceKey("https://Example.com/a/"), "https://example.com/a");
assert.equal(isCitationMarker("1"), true);
assert.equal(isCitationMarker("[12]"), true);
assert.equal(isCitationMarker("Issue #12"), false);

// compactSource carries the flags through and leaves out fields cards do not have.
assert.deepEqual(
  compactSource({ provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true }),
  { provider: "grok-responses", url: "https://example.com/o", source_type: "searched", opened: true }
);

const compacted = compactSource(
  {
    provider: "grok-responses",
    title: "  Example  ",
    url: "https://example.com/a",
    snippet: "abcdefghijklmnopqrstuvwxyz",
    raw_field: { hidden: true },
  },
  { sourceChars: 10 }
);
assert.deepEqual(compacted, {
  provider: "grok-responses",
  url: "https://example.com/a",
  title: "Example",
  snippet: "abcdefghij",
});
assert.equal(Object.hasOwn(compacted, "description"), false);
assert.equal(Object.hasOwn(compacted, "content"), false);

const noSnippet = compactSource({ provider: "grok", url: "https://example.com/b", snippet: "hidden" }, { sourceChars: 0 });
assert.deepEqual(noSnippet, { provider: "grok", url: "https://example.com/b" });

// Over the cap, cards are picked in Grok's order (cited > opened > searched, input order within
// each) and printed in input order.
const rankedSources = [
  { url: "https://e.example/1", source_type: "searched" },
  { url: "https://e.example/2", source_type: "searched", opened: true },
  { url: "https://e.example/3", source_type: "citation" },
  { url: "https://e.example/4", source_type: "searched" },
];
const capped = selectSources(rankedSources, { maxSources: 2 });
assert.deepEqual(
  capped.items.map((source) => source.url),
  ["https://e.example/2", "https://e.example/3"]
);
assert.equal(capped.total, 4);
assert.equal(capped.returned, 2);
assert.equal(capped.omitted, 2);
assert.deepEqual(
  selectSources(rankedSources, { maxSources: 3 }).items.map((source) => source.url),
  ["https://e.example/1", "https://e.example/2", "https://e.example/3"]
);

const uncapped = selectSources(rankedSources, { maxSources: 10 });
assert.equal(uncapped.returned, 4);
assert.equal(uncapped.omitted, 0);
assert.deepEqual(uncapped.items, rankedSources);
assert.deepEqual(selectSources([], { maxSources: 5 }), { items: [], total: 0, returned: 0, omitted: 0 });

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
