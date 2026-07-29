// Minimal Atom/RSS reader for Google Alerts feeds. No external dependencies:
// Google Alerts feeds are small, well-formed Atom, so a targeted regex extractor
// is sufficient (and avoids pulling in an XML parser). See docs/RssAlertIngestion.md.

export type RssEntry = {
  guid: string;
  title: string;
  link: string;
  snippet: string;
  publishedAt: number | null;
};

export type RssFetchResult = {
  ok: boolean;
  notModified: boolean;
  status: number;
  etag: string | null;
  entries: RssEntry[];
  error?: string;
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-zA-Z#0-9]+;/g, (match) => ENTITIES[match] ?? match);
}

export function stripHtml(input: string): string {
  // Decode first: Google Alerts encodes result markup as entities (&lt;b&gt;),
  // so tags only become strippable after decoding.
  const decoded = decodeEntities(input);
  return decodeEntities(decoded.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Google Alerts wraps result links in a redirect: /url?q=<real>&... or
// /url?url=<real>&.... Unwrap to the underlying target when present.
export function unwrapGoogleLink(link: string): string {
  const trimmed = link.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (/(^|\.)google\./i.test(url.hostname) && url.pathname.startsWith("/url")) {
      const target = url.searchParams.get("url") || url.searchParams.get("q");
      if (target) return target;
    }
  } catch {
    // not an absolute URL — return as-is
  }
  return trimmed;
}

function firstTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1]! : null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// Extract the href from an Atom <link .../> (self-closing, attribute-based) or
// the text body of an RSS <link>...</link>.
function extractLink(block: string): string {
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i);
  if (atom) return atom[1]!;
  const rss = firstTag(block, "link");
  return rss ? rss.trim() : "";
}

function parseBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1]!);
  }
  return blocks;
}

export function parseFeed(xml: string): RssEntry[] {
  // Atom uses <entry>, RSS 2.0 uses <item>. Prefer whichever is present.
  const atomBlocks = parseBlocks(xml, "entry");
  const blocks = atomBlocks.length ? atomBlocks : parseBlocks(xml, "item");
  const entries: RssEntry[] = [];
  for (const block of blocks) {
    const rawLink = extractLink(block);
    const link = unwrapGoogleLink(rawLink);
    const guid = (firstTag(block, "id") ?? firstTag(block, "guid") ?? link ?? "").trim();
    if (!guid) continue;
    const title = stripHtml(firstTag(block, "title") ?? "");
    const snippet = stripHtml(firstTag(block, "content") ?? firstTag(block, "summary") ?? firstTag(block, "description") ?? "");
    const publishedAt = parseTimestamp(
      firstTag(block, "published") ?? firstTag(block, "updated") ?? firstTag(block, "pubDate"),
    );
    entries.push({ guid, title, link, snippet, publishedAt });
  }
  return entries;
}

export async function fetchFeed(feedUrl: string, etag?: string | null): Promise<RssFetchResult> {
  const headers: Record<string, string> = {
    "user-agent": "AthenaKindling/1.0 (+alert-ingestion)",
    accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
  };
  if (etag) headers["if-none-match"] = etag;
  let response: Response;
  try {
    response = await fetch(feedUrl, { headers, redirect: "follow" });
  } catch (error) {
    return {
      ok: false,
      notModified: false,
      status: 0,
      etag: etag ?? null,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 304) {
    return { ok: true, notModified: true, status: 304, etag: etag ?? null, entries: [] };
  }
  if (!response.ok) {
    return {
      ok: false,
      notModified: false,
      status: response.status,
      etag: response.headers.get("etag"),
      entries: [],
      error: `HTTP ${response.status}`,
    };
  }
  const xml = await response.text();
  return {
    ok: true,
    notModified: false,
    status: response.status,
    etag: response.headers.get("etag"),
    entries: parseFeed(xml),
  };
}
