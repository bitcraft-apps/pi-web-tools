// Inputs shared by the contract tests. Small and fixed: a contract test proves
// the binary still accepts our argv and still emits the shape we parse, so the
// input must stay boring.

/**
 * 157 characters on one line. Long enough that a converter with a column limit
 * has to break it, so `--wrap=none` (pandoc) and `-cols 120` (w3m) both become
 * observable.
 */
export const LONG_SENTENCE =
  "This one sentence is deliberately longer than one hundred and twenty characters, so a converter that wraps its output must break it across more than one line.";

/** Input for the two HTML→markdown converters: heading, link, long paragraph, list. */
export const CONVERTER_HTML = `<!doctype html>
<html>
  <head><title>Contract</title></head>
  <body>
    <h1>Contract Heading</h1>
    <p>Body text with a <a href="https://example.com/link">link</a>.</p>
    <p>${LONG_SENTENCE}</p>
    <ul><li>first item</li></ul>
  </body>
</html>
`;

/** A sentence from the article body. Both extractors must keep it. */
export const ARTICLE_SENTENCE =
  "The article body states one fact clearly and at sufficient length that any extractor keeps it in the main content.";

/**
 * Input for the two extractors: an article wrapped in page chrome. The chrome
 * markers are nonsense words so a substring assertion cannot match the article
 * text by accident. The relative link makes rdrview's `-u` observable.
 */
export const ARTICLE_HTML = `<!doctype html>
<html>
  <head><title>Contract Article</title></head>
  <body>
    <nav>Home Products Careers NAVCHROME</nav>
    <article>
      <h1>Article Heading</h1>
      <p>${ARTICLE_SENTENCE}</p>
      <p>A second paragraph of the article body, also long enough to survive precision-oriented content extraction heuristics. It links to <a href="/relative/page">another page</a>.</p>
    </article>
    <footer>FOOTERCHROME copyright 2026</footer>
  </body>
</html>
`;

/** Base URL passed to rdrview's `-u`, used to resolve `/relative/page` above. */
export const ARTICLE_URL = "https://example.com/articles/contract";

/**
 * Build a one-page uncompressed PDF whose only text is `text`.
 *
 * Hand-written rather than committed as a binary fixture: the whole file is
 * ASCII, so the diff is reviewable, and poppler reconstructs the missing xref
 * table without complaint. Non-ASCII characters go in as PDF octal escapes
 * against `WinAnsiEncoding` (`\351` = é, `\357` = ï), which is what makes
 * `-enc UTF-8` observable — pdftotext has to decode WinAnsi and re-encode.
 */
export function onePagePdf(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
  const pdf = [
    "%PDF-1.4\n",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n",
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>endobj\n",
    `5 0 obj<</Length ${content.length}>>stream\n`,
    content,
    "endstream endobj\n",
    "trailer<</Root 1 0 R/Size 6>>\n%%EOF\n",
  ].join("");
  // Latin-1: every byte of the template above is ASCII, and this keeps one
  // source character equal to one PDF byte so /Length stays correct.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Text placed on the PDF page. The escapes render as "café naïve". */
export const PDF_TEXT_SOURCE = "Contract page: caf\\351 na\\357ve";

/** What pdftotext must give back for `PDF_TEXT_SOURCE` under `-enc UTF-8`. */
export const PDF_TEXT_DECODED = "Contract page: café naïve";

/** Every external binary gets 10s; these calls take tens of ms in practice. */
export const CONTRACT_TIMEOUT_MS = 10_000;
