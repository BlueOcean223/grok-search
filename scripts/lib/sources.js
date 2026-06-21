const URL_PATTERN = /https?:\/\/[^\s<>"'`，。、；：！？》）】)]+/g;
const MD_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
const SOURCES_HEADING_PATTERN =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)\s*(?:\*\*|__)?(?:\s*[（(][^)\n]*[)）])?\s*[:：]?\s*$/gim;
const SOURCES_FUNCTION_PATTERN =
  /(^|\n)\s*(sources|source|citations|citation|references|reference|citation_card|source_cards|source_card)\s*\(/gim;

function trimUrl(value) {
  return String(value || "").replace(/[.,;:!?，。、；：！？》）】)]+$/g, "");
}

export function normalizeSourceUrl(url) {
  try {
    const parsed = new URL(trimUrl(url));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    }
    return parsed.toString();
  } catch {
    return String(url || "").trim();
  }
}

export function extractUniqueUrls(text) {
  const seen = new Set();
  const urls = [];
  for (const match of String(text || "").matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function mergeSources(...sourceLists) {
  const seen = new Set();
  const merged = [];

  for (const sources of sourceLists) {
    for (const item of sources || []) {
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      if (!url) continue;
      const key = normalizeSourceUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, url });
    }
  }

  return merged;
}

export function splitAnswerAndSources(text) {
  const raw = String(text || "").trim();
  if (!raw) return { answer: "", sources: [] };

  return (
    splitFunctionCallSources(raw) ||
    splitHeadingSources(raw) ||
    splitDetailsBlockSources(raw) ||
    splitTailLinkBlock(raw) || { answer: raw, sources: [] }
  );
}

export function extractSources(text) {
  return extractSourcesFromText(text);
}

function splitFunctionCallSources(text) {
  const matches = [...text.matchAll(SOURCES_FUNCTION_PATTERN)];
  if (!matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const openParenIndex = match.index + match[0].length - 1;
    const extracted = extractBalancedCallAtEnd(text, openParenIndex);
    if (!extracted) continue;

    const sources = parseSourcesPayload(extracted.argsText);
    if (!sources.length) continue;
    return { answer: text.slice(0, match.index).trimEnd(), sources };
  }

  return null;
}

function extractBalancedCallAtEnd(text, openParenIndex) {
  if (openParenIndex < 0 || text[openParenIndex] !== "(") return null;

  let depth = 1;
  let inString = null;
  let escape = false;

  for (let index = openParenIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === "'" || char === '"') {
      inString = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        if (text.slice(index + 1).trim()) return null;
        return { closeParenIndex: index, argsText: text.slice(openParenIndex + 1, index) };
      }
    }
  }

  return null;
}

function splitHeadingSources(text) {
  const matches = [...text.matchAll(SOURCES_HEADING_PATTERN)];
  if (!matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const sourcesText = text.slice(match.index);
    const sources = extractSourcesFromText(sourcesText);
    if (!sources.length) continue;
    return { answer: text.slice(0, match.index).trimEnd(), sources };
  }

  return null;
}

function splitDetailsBlockSources(text) {
  const lower = text.toLowerCase();
  const closeIndex = lower.lastIndexOf("</details>");
  if (closeIndex === -1) return null;
  if (text.slice(closeIndex + "</details>".length).trim()) return null;

  const openIndex = lower.lastIndexOf("<details", closeIndex);
  if (openIndex === -1) return null;

  const blockText = text.slice(openIndex, closeIndex + "</details>".length);
  const sources = extractSourcesFromText(blockText);
  if (sources.length < 2) return null;
  return { answer: text.slice(0, openIndex).trimEnd(), sources };
}

function splitTailLinkBlock(text) {
  const lines = text.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].trim()) index -= 1;
  if (index < 0) return null;

  const tailEnd = index;
  let linkLikeCount = 0;
  while (index >= 0) {
    const line = lines[index].trim();
    if (!line) {
      index -= 1;
      continue;
    }
    if (!isLinkOnlyLine(line)) break;
    linkLikeCount += 1;
    index -= 1;
  }

  const tailStart = index + 1;
  if (linkLikeCount < 2) return null;

  const blockText = lines.slice(tailStart, tailEnd + 1).join("\n");
  const sources = extractSourcesFromText(blockText);
  if (!sources.length) return null;
  return { answer: lines.slice(0, tailStart).join("\n").trimEnd(), sources };
}

function isLinkOnlyLine(line) {
  const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim();
  if (!stripped) return false;
  return stripped.startsWith("http://") || stripped.startsWith("https://") || /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(stripped);
}

function parseSourcesPayload(payload) {
  const raw = String(payload || "").trim().replace(/;$/, "");
  if (!raw) return [];

  const parsed = parseJsonish(raw);
  if (parsed == null) return extractSourcesFromText(raw);

  if (isPlainObject(parsed)) {
    for (const key of ["sources", "citations", "references", "urls"]) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        return normalizeSources(parsed[key]);
      }
    }
  }

  return normalizeSources(parsed);
}

function parseJsonish(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Continue with a deliberately narrow JS/Python-literal compatibility pass.
  }

  const normalized = raw
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value) => JSON.stringify(value.replace(/\\'/g, "'")));

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function normalizeSources(data) {
  const items = Array.isArray(data) ? data : [data];
  const normalized = [];
  const seen = new Set();

  for (const item of items) {
    if (typeof item === "string") {
      for (const url of extractUniqueUrls(item)) pushSource(normalized, seen, { url });
      continue;
    }

    if (Array.isArray(item) && item.length >= 2) {
      const [title, url] = item;
      if (typeof url !== "string" || !url.startsWith("http")) continue;
      pushSource(normalized, seen, {
        url,
        ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
      });
      continue;
    }

    if (isPlainObject(item)) {
      const url = item.url || item.href || item.link;
      if (typeof url !== "string" || !url.startsWith("http")) continue;
      const title = item.title || item.name || item.label;
      const description = item.description || item.snippet || item.content;
      pushSource(normalized, seen, {
        url,
        ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
        ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
      });
    }
  }

  return normalized;
}

function extractSourcesFromText(text) {
  const sources = [];
  const seen = new Set();

  for (const match of String(text || "").matchAll(MD_LINK_PATTERN)) {
    const title = match[1]?.trim();
    const url = trimUrl(match[2]);
    pushSource(sources, seen, {
      url,
      ...(title ? { title } : {}),
    });
  }

  for (const url of extractUniqueUrls(text)) {
    pushSource(sources, seen, { url });
  }

  return sources;
}

function pushSource(out, seen, source) {
  const url = typeof source.url === "string" ? trimUrl(source.url.trim()) : "";
  if (!url) return;
  const key = normalizeSourceUrl(url);
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ ...source, url });
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
