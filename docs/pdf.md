# PDF support (optional)

If [`pdftotext`](https://poppler.freedesktop.org/) (poppler) is on `$PATH`, `webfetch` will accept `application/pdf` responses and return the extracted plain text. Useful for academic papers, RFCs served as PDF, datasheets, vendor manuals, government docs — the things you'd otherwise have to download and paste excerpts from.

**Install:**

```bash
brew install poppler         # macOS
# apt install poppler-utils  # Debian/Ubuntu
# dnf install poppler-utils  # Fedora
```

Detected once per process and cached. `webfetch` invokes `pdftotext -layout -enc UTF-8 - -` on the response bytes; `-layout` preserves two-column papers and tables, which the default reading-order mode mangles. Output is plain text — no markdown wrapping, no fences (PDFs aren't structured for markdown rendering; pretending they are produces worse output than `pdftotext -layout`).

No `pdftotext` present? PDFs are rejected with the existing "Cannot fetch application/pdf" error — byte-for-byte the same behavior as before. A one-shot warning is written to stderr on the first PDF fetch so you know what you're missing; it is **never** added to tool output.

## Caveats

- **Scanned / image-only PDFs** return empty or near-empty text. OCR (e.g. `tesseract`) is a much heavier dependency and a separate decision; out of scope.
- **No DOCX, EPUB, RTF, ODT.** Each is a separate optional binary with its own quirks. Open an issue if you need one.
- **No PDF form / annotation extraction.**
- **5 MB response cap still applies.** A 50 MB PDF will be rejected before `pdftotext` ever runs.
