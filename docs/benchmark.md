# Benchmark

The public repository contains a compact, reproducible benchmark rather than the complete private experiment archive.

## Public scope

- Frozen 15-question current-fact set.
- Official-source ground truth and deterministic field matchers.
- Responses-only runner compatible with xAI, OpenRouter, and Responses-compatible relays.
- Correctness, stale-answer, official Hit@5, and latency scoring.
- One sanitized aggregate result sample.

Raw responses, full page caches, private channel configuration, relay identity, and per-request pricing remain local and are not part of the public repository.

## Sanitized 2026-07-11 sample

| System | Main result | Official retrieval | Evidence coverage | Average latency |
| --- | ---: | ---: | ---: | ---: |
| Grok Responses / official | 15/15 fully correct | Hit@5 100% | 79.6% | 36.8s |
| Brave raw | URL-discovery baseline | Hit@1 80%, Hit@5 86.7% | snippets 23.7%, refetched 69.3% | 1.7s |
| Tavily raw | retrieval baseline | Hit@1 60%, Hit@5 86.7% | snippets 45.3%, refetched 76.5% | 2.8s |

These values are a dated sample, not a permanent provider ranking. Search indexes, models, pricing, and channel behavior can change.

## Reproduce

Start with three questions:

```bash
npm run benchmark -- --only node,rust,python
npm run benchmark:score
```

Raw run output is stored under the Git-ignored `benchmarks/results/` directory by default. See [benchmarks/README.md](../benchmarks/README.md) and [evaluation methodology](web-search-evaluation-research.md).
