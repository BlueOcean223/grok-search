/**
 * Direct Fetch: the page as the server sends it, with HTML reduced to readable text. Under auto it
 * runs first to catch servers that negotiate Markdown or serve plain files, and last as the copy
 * to fall back on; it is also the free, dated path for X posts (see directFirstForX).
 */
import { readableText } from "./html.js";
import { getText, trimBody } from "./http.js";
import { escapeRegExp, isXUrl, parseXPostUrl } from "./sources.js";

const DIRECT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const DIRECT_ERROR_PREVIEW_BYTES = 1000;
// Markdown first: sites that negotiate it (code.claude.com, platform.openai.com, sites on
// Cloudflare's Markdown for Agents) send the page as Markdown, without navigation. 45 of 153
// HTML URLs on record did (2026-10-10); none that worked with the previous header (text/html
// first) failed with this one.
const DIRECT_FETCH_ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8";

function directMetadata(got) {
  return {
    status: got.status,
    content_type: got.content_type || null,
    content_length: got.content_length,
    content_disposition: got.content_disposition,
  };
}

/** This adapter's wording for what getText could not do. */
function failureMessage(got, maxBytes) {
  if (got.reason === "binary") return "目标看起来是二进制或附件，未注入正文";
  if (got.reason === "too_large") return `响应超过 Direct Fetch 首版上限 ${maxBytes} bytes，${got.cut ? "未注入正文" : "未下载正文"}`;
  return got.error;
}

export async function directFetch(url, options = {}) {
  const maxBytes = options.maxBytes || DIRECT_FETCH_MAX_BYTES;
  const warnings = [];
  const got = await getText(url, {
    accept: DIRECT_FETCH_ACCEPT,
    timeoutMs: options.timeoutMs || 60_000,
    maxBytes,
    previewBytes: DIRECT_ERROR_PREVIEW_BYTES,
  });

  if (!got.ok) {
    // No response at all (timeout, network): nothing to describe but the error.
    if (got.status == null) return { ok: false, provider: "direct", error: got.error, error_preview: null, metadata: {}, warnings };
    const metadata = directMetadata(got);
    return {
      ok: false,
      provider: "direct",
      final_url: got.final_url,
      redirected: got.redirected,
      error: failureMessage(got, maxBytes),
      error_preview: got.reason === "http" && got.text ? trimBody(got.text, DIRECT_ERROR_PREVIEW_BYTES) : null,
      // A body that passed the limit while being read has no known length, whatever the header said.
      metadata: got.cut ? { ...metadata, content_length: null } : metadata,
      warnings,
    };
  }

  const content = renderDirectContent(got.text, got.content_type, got.final_url);
  // HTML gets its <title> as a "# " line, so an empty page still yields text. Reddit served
  // a script-only shell on 2026-10-08 and the fetch came back as just "# Reddit". A notice,
  // not just a warning: it says the text is not the page. Other types come back as served, so a
  // Markdown file that is only a heading is that file.
  const titleOnly = /html/i.test(got.content_type) && !content.replace(/^# [^\n]*\n*/, "").trim();
  const notices = titleOnly
    ? ["Direct Fetch got no text beyond the page title; the page may need JavaScript or block automated access."]
    : [];

  return {
    ok: true,
    provider: "direct",
    content,
    final_url: got.final_url,
    redirected: got.redirected,
    metadata: directMetadata(got),
    warnings,
    notices,
    ...(titleOnly ? { title_only: true } : {}),
  };
}

/**
 * Drop exact repeats of long lines, keeping the first. X status pages render the post text
 * three times (title, Open Graph copy, timeline card); no sane page repeats a 20+ char line
 * verbatim on purpose.
 */
export function collapseRepeatedLines(text, { minLength = 20 } = {}) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const key = line.trim();
    if (key.length >= minLength) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderDirectContent(text, contentType, finalUrl) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("html")) {
    const readable = readableText(text);
    return isXUrl(finalUrl) ? collapseRepeatedLines(readable) : readable;
  }
  // Everything else comes back as served, so a raw file's full_path is the file. An agent
  // copied a fetched CHANGELOG.md on 2026-10-08 and downloaded it again with curl to check it;
  // the only difference was the final newline this used to trim.
  if (type.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

// ISO timestamps put a 'T' right after the date, so the tail needs a lookahead, not \b.
const X_DATE_PATTERN = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}(?!\d)/;
// Lines the logged-out X shell adds around (or instead of) the post.
const X_BOILERPLATE_LINE =
  /^(?:Post|Log in|Sign up|Log in or sign up for X|See what[’']s happening and join the conversation|Continue with (?:phone|Apple|Google)|or|Log in with username or email|Relevant people|Trending now|Follow|Back|Search|Something went wrong\.?.*|Try again|Don[’']t miss what[’']s happening.*|People on X are the first to know\.?|Terms\b.*|©.*X Corp\.?|-|\d[\d.,]*[KM]?(?: Views)?|\d{1,2}:\d{2} [AP]M .*)$/i;

/**
 * Did a Direct fetch of an X status page return the post, or only the login shell? X serves
 * server-rendered HTML to some clients and a JavaScript shell to others; the shell has the
 * chrome but neither the author's handle, the post date, nor any post text.
 */
export function validateXPostContent(content, post) {
  const text = String(content || "");
  const missing = [];
  const handle = post?.x_handle;
  if (!handle || !new RegExp(`@${escapeRegExp(handle)}(?![A-Za-z0-9_])`, "i").test(text)) missing.push("handle");
  if (!X_DATE_PATTERN.test(text)) missing.push("date");

  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !X_BOILERPLATE_LINE.test(line) && !/^@[A-Za-z0-9_]{1,15}$/.test(line))
    .filter((line) => !X_DATE_PATTERN.test(line) || line.length > 40);
  if (!body.some((line) => line.length >= 20)) missing.push("text");

  return { ok: missing.length === 0, missing };
}

/**
 * Whether fetchUrl(auto) should try Direct before the paid providers for this URL. Only X
 * status pages with a handle qualify (the handle is what the validation checks). Applies
 * regardless of keys (decided 2026-09-08 after a side-by-side): Tavily returns the post
 * without its date, Firecrawl bills ~30 credits and takes 10s+, Direct is free and carries
 * the date. Callers who want the thread ask for Firecrawl explicitly.
 */
export function directFirstForX(url, provider = "auto") {
  if (provider !== "auto") return null;
  const post = parseXPostUrl(url);
  return post?.x_handle && post?.x_post_id ? post : null;
}
