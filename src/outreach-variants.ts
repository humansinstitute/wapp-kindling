// The draft_outreach pipeline returns one markdown blob containing several
// outreach options, separated by horizontal rules (`---`) and each led by a
// `## <variant name>` heading. We store each option as its own outreach_drafts
// row so the UI can page between them. This parser is shared by the ingestion
// webhook and the one-off backfill migration.

export interface OutreachVariant {
  index: number;
  label: string;
  body: string;
}

// Split a pitch blob into ordered variants. Always returns at least one entry
// (the whole text) so callers can insert unconditionally.
export function splitPitchVariants(pitchText: string): OutreachVariant[] {
  const raw = String(pitchText ?? "").trim();
  if (!raw) return [{ index: 0, label: "Option 1", body: "" }];

  // Primary split: markdown horizontal rules on their own line (---, ***, ___).
  let chunks = raw
    .split(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/m)
    // The capture group leaks the rule char into the result array — drop the
    // single-char fragments, keep the real content chunks.
    .filter((c) => c != null && c.trim().length > 1)
    .map((c) => c.trim());

  // Fallback: no rules but multiple `## headings` — split on heading boundaries.
  if (chunks.length < 2) {
    const headingCount = (raw.match(/^##\s+.+$/gm) || []).length;
    if (headingCount >= 2) {
      chunks = raw
        .split(/\n(?=##\s+\S)/)
        .map((c) => c.trim())
        .filter(Boolean);
    }
  }

  if (chunks.length < 2) chunks = [raw];

  return chunks.map((chunk, index) => {
    const headingMatch = chunk.match(/^##\s+(.+?)\s*$/m);
    const label = headingMatch ? headingMatch[1].trim() : `Option ${index + 1}`;
    // Strip the leading heading line from the body so the variant label isn't
    // duplicated above the rendered preview.
    const body = headingMatch
      ? chunk.replace(/^##\s+.+?\r?\n+/, "").trim()
      : chunk;
    return { index, label, body };
  });
}
