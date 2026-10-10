/**
 * HTML read without a parser: entities, links, and the page as readable text. Enough for a
 * last-resort fetch and for finding a page's links; the extractors (Firecrawl, Tavily) do the
 * real rendering.
 */

export function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    hellip: "...",
  };

  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

/**
 * The page's text with its <title> as a "# " line, block tags as line breaks and list items as
 * "- " lines; scripts, styles and SVG dropped.
 */
export function readableText(html) {
  const withoutComments = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = withoutComments.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ").trim()) : "";

  let body = withoutComments
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  body = decodeHtmlEntities(body)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (title && !body.startsWith(title)) {
    return `# ${title}\n\n${body}`.trim();
  }
  return body;
}

/** The href values of a page's <a> tags, as written. */
export function hrefValues(html) {
  const values = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    values.push(match[1] || match[2] || match[3] || "");
  }
  return values;
}
