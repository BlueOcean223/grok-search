/**
 * Judging fetched page text: whether an extract looks like a skeleton, and how much real
 * text one copy of a page has that another lacks. "Real text" is lines of 40 characters or
 * more once Markdown links are reduced to their text: navigation items, labels and buttons
 * are short, sentences are not.
 */

const LONG_LINE = 40;

function plainLine(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|\\]/g, "")
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function longLines(text) {
  return String(text || "")
    .split("\n")
    .map(plainLine)
    .filter((line) => line.length >= LONG_LINE);
}

// Lines are matched on their first letters and digits, so the same sentence matches across
// providers that format punctuation, list markers or code differently.
function lineKey(line) {
  return line.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 24);
}

/** Characters in the long lines of `text`. */
export function proseChars(text) {
  return longLines(text).reduce((total, line) => total + line.length, 0);
}

/** Characters in the long lines of `text` that `base` does not have. */
export function addedProseChars(text, base) {
  const known = longLines(base).map(lineKey).join("|");
  return longLines(text)
    .filter((line) => !known.includes(lineKey(line)))
    .reduce((total, line) => total + line.length, 0);
}

/**
 * Whether an extract looks like it lost the page's body: under 1,500 characters, or at least
 * five headings of which half or more have nothing under them. Tavily returned GitHub issues
 * as bare headings (openclaw#91956: 664 characters, 17 of 23 headings empty) and arXiv abstract
 * pages without the abstract.
 */
export function looksThin(text) {
  const value = String(text || "");
  if (value.length < 1500) return true;
  const lines = value.split("\n");
  const headings = [];
  lines.forEach((line, index) => {
    if (/^#{1,6}\s/.test(line)) headings.push(index);
  });
  if (headings.length < 5) return false;
  const empty = headings.filter((start, k) => !lines.slice(start + 1, headings[k + 1] ?? lines.length).join("\n").trim()).length;
  return empty * 2 >= headings.length;
}

/**
 * Whether `candidate` has clearly more of the page than `base`: at least 1,000 characters of
 * long lines `base` lacks, and at least as many as `base` has in all. Tuned on the 19 Tavily
 * extracts that looksThin flagged (2026-09-15 to 10-09) against Direct copies fetched
 * 2026-10-10: it picked Direct for all 8 that had lost text and kept Tavily for the 9 that
 * had not, where Direct only added navigation and footers.
 */
export function clearlyFuller(candidate, base) {
  const added = addedProseChars(candidate, base);
  return added >= 1000 && added >= proseChars(base);
}
