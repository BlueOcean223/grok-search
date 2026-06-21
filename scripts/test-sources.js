#!/usr/bin/env node
import assert from "node:assert/strict";
import { extractUniqueUrls, mergeSources, splitAnswerAndSources } from "./lib/sources.js";

const fixtures = [
  {
    name: "function call JSON array",
    input: 'Answer text.\nsources([{"title":"Alpha","url":"https://a.example/path"}])',
    answer: "Answer text.",
    urls: ["https://a.example/path"],
  },
  {
    name: "function call object",
    input: 'Answer text.\nreferences({"sources":[{"name":"Beta","href":"https://b.example/docs"}]})',
    answer: "Answer text.",
    urls: ["https://b.example/docs"],
  },
  {
    name: "single quotes and Python literals",
    input: "Answer text.\nsources([{'title':'Gamma','url':'https://g.example'}, {'url':'https://n.example','description': None}])",
    answer: "Answer text.",
    urls: ["https://g.example", "https://n.example"],
  },
  {
    name: "Sources heading",
    input: "Answer text.\n\nSources:\n- [Delta](https://d.example/article)",
    answer: "Answer text.",
    urls: ["https://d.example/article"],
  },
  {
    name: "References heading",
    input: "Answer text.\n\n## References\nhttps://r.example/one\nhttps://r.example/two",
    answer: "Answer text.",
    urls: ["https://r.example/one", "https://r.example/two"],
  },
  {
    name: "Chinese heading",
    input: "Answer text.\n\n### 信源\n- https://cn.example/资料",
    answer: "Answer text.",
    urls: ["https://cn.example/资料"],
  },
  {
    name: "details block",
    input:
      "Answer text.\n\n<details><summary>Sources</summary>\n- [One](https://detail.example/one)\n- [Two](https://detail.example/two)\n</details>",
    answer: "Answer text.",
    urls: ["https://detail.example/one", "https://detail.example/two"],
  },
  {
    name: "tail link block",
    input: "Answer text.\n\nhttps://tail.example/one\n- https://tail.example/two.",
    answer: "Answer text.",
    urls: ["https://tail.example/one", "https://tail.example/two"],
  },
];

for (const fixture of fixtures) {
  const result = splitAnswerAndSources(fixture.input);
  assert.equal(result.answer, fixture.answer, `${fixture.name}: answer`);
  assert.deepEqual(
    result.sources.map((source) => source.url),
    fixture.urls,
    `${fixture.name}: urls`
  );
}

assert.deepEqual(extractUniqueUrls("See https://x.example/a, then https://x.example/a and https://y.example/b."), [
  "https://x.example/a",
  "https://y.example/b",
]);

assert.deepEqual(
  mergeSources([{ url: "https://A.example/path/" }], [{ url: "https://a.example/path#section" }, { url: "https://b.example/" }]).map(
    (source) => source.url
  ),
  ["https://A.example/path/", "https://b.example/"]
);

console.log("sources fixtures ok");
