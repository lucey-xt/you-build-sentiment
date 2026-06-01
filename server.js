import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;

// --- Config -----------------------------------------------------------------

const API_ENDPOINT = "https://ydc-index.io/v1/search";
// Prefer the env var; fall back to the key supplied for this build so it runs
// out of the box.
const API_KEY =
  process.env.YDC_API_KEY ||
  "ydc-sk-2b3ef6f6f61f8a28-oCAUgM5DuX6LXPJINM9Y4rKPyVsE1hin-7f414e56";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Recency window. The endpoint only supports preset freshness values
// (day/week/month/year), so we send the tightest preset that still covers our
// window (`year`) to narrow at the source, then apply an exact month-based
// cutoff client-side using each result's reported page age.
const FRESHNESS = "year";
const MONTHS_BACK = 6;

// Cutoff date for the client-side filter (now minus MONTHS_BACK months).
function freshnessCutoff() {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS_BACK);
  return d;
}

// Keep a result if it's within the window. Results with no reported date are
// kept: the API's `freshness=year` already caps them at ~12 months, and X and
// GitHub rarely report a date — dropping all undated items would gut those two
// sources. Only items with a date *older* than the cutoff are removed.
function withinWindow(pageAge, cutoff) {
  if (!pageAge) return true;
  const t = Date.parse(pageAge);
  if (Number.isNaN(t)) return true;
  return t >= cutoff.getTime();
}

// Sentiment is sampled ONLY from these developer communities. Each competitor
// query is run once per domain (via a `site:` filter) and the results merged,
// so every card draws on all of them. (X was dropped: the index surfaces almost
// no recent third-party developer sentiment there for these tools — mostly the
// products' own accounts.)
const SOURCES = [
  { domain: "reddit.com", label: "Reddit" },
  { domain: "news.ycombinator.com", label: "Hacker News" },
  { domain: "producthunt.com", label: "Product Hunt" },
  { domain: "github.com", label: "GitHub" },
];
const ALLOWED_HOSTS = SOURCES.map((s) => s.domain);

// Competitors in the "provide web context to LLMs" space. Each becomes a
// column. The query is tuned toward *developer* sentiment on that topic; the
// `site:` restriction is appended per-source at fetch time.
// `match` lists the terms that must appear (in the title, snippet, or URL) for a
// result to count toward this product's sentiment. Plain words are matched on
// word boundaries (so "exa" won't match "example"); terms containing dots or
// spaces are matched as substrings.
// `official` lists the product's own account/org handles on x.com, github.com,
// and reddit. Results posted by these are first-party marketing, not developer
// sentiment, so they're excluded.
const COMPETITORS = [
  {
    id: "youcom",
    name: "You.com",
    query:
      "You.com search API developer experience providing web context to LLMs grounding",
    match: ["you.com", "youchat", "ydc-index", "you.com api"],
    official: ["you", "youdotcom", "you-com", "youcom", "yousearchengine", "youdotcomai"],
  },
  {
    id: "tavily",
    name: "Tavily",
    query:
      "Tavily search API developer experience web context for LLMs RAG grounding review",
    match: ["tavily"],
    official: ["tavily", "tavilyai", "tavily-ai"],
  },
  {
    id: "exa",
    name: "Exa",
    query:
      "Exa AI search API developer experience web context for LLMs RAG review",
    match: ["exa.ai", "exa ai", "exa api", "exa search", "metaphor systems"],
    official: ["exa", "exaai", "exaailabs", "exa-labs", "exalabs", "metaphor", "metaphorsystems"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    query:
      "Perplexity Sonar API developer experience web search context for LLMs review",
    match: ["perplexity", "sonar api"],
    official: ["perplexity", "perplexity_ai", "perplexityai", "ppl-ai", "pplai"],
  },
  {
    id: "brave",
    name: "Brave Search API",
    query:
      "Brave Search API developer experience web context for LLMs grounding RAG review",
    match: ["brave search", "brave api", "brave's search"],
    official: ["brave", "bravesearch", "brave-browser", "search_brave"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    query:
      "Firecrawl developer experience scraping web content as context for LLMs review",
    match: ["firecrawl"],
    official: ["firecrawl", "firecrawl_dev", "firecrawldev", "mendable", "mendableai"],
  },
];

function termMatches(text, term) {
  const t = term.toLowerCase();
  if (/[^a-z0-9]/.test(t)) return text.includes(t); // dotted/multi-word -> substring
  return new RegExp(`\\b${t}\\b`).test(text); // single word -> word boundary
}

// Match terms for every *other* tracked product — used to filter out opinions
// that are really about a competitor.
function otherMatchTerms(id) {
  return COMPETITORS.filter((c) => c.id !== id).flatMap((c) => c.match);
}

// The account/org/subreddit that published a result: the owner segment of the
// URL (e.g. x.com/<owner>/…, github.com/<owner>/…, reddit.com/r/<owner> or
// reddit.com/user/<owner>).
function ownerOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const segs = u.pathname.split("/").filter(Boolean);
    if (host.endsWith("reddit.com")) {
      return (segs[0] === "r" || segs[0] === "user" ? segs[1] : "") || "";
    }
    // x.com / twitter.com / github.com → first path segment is the handle/org.
    return segs[0] || "";
  } catch {
    return "";
  }
}

// True when the result was posted by the product's own account/org/brand
// handle — i.e. it's the product talking about itself, not a developer.
function isFirstParty(url, official = []) {
  const owner = ownerOf(url).toLowerCase().replace(/^@/, "");
  if (!owner) return false;
  return official.some((h) => {
    const handle = h.toLowerCase();
    // Exact owner match always counts; substring only for distinctive handles
    // (length >= 4) so short tokens like "you"/"exa" don't over-match.
    return owner === handle || (handle.length >= 4 && owner.includes(handle));
  });
}

// True when one of the product's `match` terms appears anywhere in the result
// (title, ANY snippet, or URL). Reddit snippets often lead with vote-count
// metadata, so the mention may sit in a later snippet than the displayed one.
function mentionsProduct(result, matchTerms) {
  const hay = `${result.title} ${result.matchText} ${result.url}`.toLowerCase();
  return matchTerms.some((term) => termMatches(hay, term));
}

// Choose the snippet to display: prefer one that names the product and isn't
// first-party marketing copy; then any non-promo snippet; else fall back.
function pickSnippet(snippets, matchTerms) {
  const named = snippets.find(
    (sn) =>
      !isPromo(sn) && matchTerms.some((term) => termMatches(sn.toLowerCase(), term))
  );
  return named || snippets.find((sn) => !isPromo(sn)) || snippets[0] || "";
}

// --- Sentiment heuristic ----------------------------------------------------
// Lightweight, deterministic lexical scoring over the returned snippets. This
// avoids a second LLM round-trip while still giving each column a directional
// read on how developers are talking about the tool.

const POSITIVE = [
  "best","great","excellent","powerful","fast","accurate","reliable","love",
  "easy","seamless","robust","impressive","recommend","favorite","useful",
  "helpful","efficient","clean","simple","scalable","flexible","improved",
  "superior","leading","quality","precise","relevant","trusted","intuitive",
];
const NEGATIVE = [
  "slow","expensive","poor","bad","unreliable","broken","bug","limited",
  "difficult","confusing","lacking","disappointing","hard","fails","failure",
  "error","outdated","missing","worse","worst","frustrating","clunky",
  "deprecated","inaccurate","hallucinate","problem","issue","concern",
];

const NEGATORS = new Set([
  "not","no","never","without","hardly","barely","nor","cant","cannot",
  "dont","doesnt","isnt","wasnt","arent","wont","didnt",
]);

// First-party / marketing voice: announcements and self-description, even when
// relayed by a third-party account. This is the product talking about itself,
// not independent developer sentiment, so it's excluded from bullets, the
// displayed snippet, and the sentiment score.
const PROMO_PATTERNS = [
  /\bintroducing\b/i,
  /\btoday,?\s+we('|\sa)?re\b/i,
  /\bwe('|\sa)?re\s+(excited|thrilled|proud|launching|introducing|building|an?\s|the\s)/i,
  /\bwe('|\sha)?ve\s+(built|launched|created|developed|designed)\b/i,
  /\bwe\s+(built|launched|created|designed|are\s+launching)\b/i,
  /\bour\s+(new\s+)?[\w-]+\s+(api|search|platform|engine|index)\b/i,
  /\b(sign\s?up|get\s+started|try\s+it\s+free|book\s+a\s+demo)\b/i,
];

function isPromo(text) {
  return PROMO_PATTERNS.some((re) => re.test(text));
}

// Generic sentiment words that aren't useful as concrete "attributes" in the
// So-what summary (we want "fast"/"expensive", not "great"/"bad").
const GENERIC_SENTIMENT = new Set([
  "best","great","good","love","impressive","recommend","favorite","superior",
  "leading","excellent","trusted","useful","helpful","bad","poor","worse",
  "worst","problem","issue","concern","error","fails","failure","hard",
  "lacking","disappointing","frustrating","missing",
]);

// Count concrete praised/criticised attributes across a product's matched
// discussion (skipping marketing copy). Returns sorted [{word, count}] lists.
function aspectCounts(results) {
  const pos = {};
  const neg = {};
  for (const r of results) {
    const text = `${r.title} ${r.matchText || r.snippet}`;
    for (const sentence of text.split(/(?<=[.!?])\s+|\s*\|\|?\s*/)) {
      if (isPromo(sentence)) continue;
      for (const w of sentence.toLowerCase().match(/[a-z']+/g) || []) {
        if (GENERIC_SENTIMENT.has(w)) continue;
        if (POSITIVE.includes(w)) pos[w] = (pos[w] || 0) + 1;
        else if (NEGATIVE.includes(w)) neg[w] = (neg[w] || 0) + 1;
      }
    }
  }
  const sortTop = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([word, count]) => ({ word, count }));
  return { positive: sortTop(pos), negative: sortTop(neg) };
}

function scoreText(text) {
  const words = (text || "").toLowerCase().match(/[a-z']+/g) || [];
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // A negator within the previous 3 words flips the polarity ("not great").
    const negated = words
      .slice(Math.max(0, i - 3), i)
      .some((x) => NEGATORS.has(x) || x.endsWith("n't"));
    if (POSITIVE.includes(w)) negated ? neg++ : pos++;
    else if (NEGATIVE.includes(w)) negated ? pos++ : neg++;
  }
  return { pos, neg };
}

function summarizeSentiment(results) {
  let pos = 0;
  let neg = 0;
  for (const r of results) {
    // Score the full snippet text (richer than the single displayed snippet),
    // sentence by sentence, skipping first-party marketing copy.
    const text = `${r.title} ${r.matchText || r.snippet}`;
    for (const sentence of text.split(/(?<=[.!?])\s+|\s*\|\|?\s*/)) {
      if (isPromo(sentence)) continue;
      const s = scoreText(sentence);
      pos += s.pos;
      neg += s.neg;
    }
  }
  const total = pos + neg;
  let label = "Neutral";
  let emoji = "➖"; // heavy minus
  if (total > 0) {
    const ratio = (pos - neg) / total;
    if (ratio > 0.25) {
      label = "Positive";
      emoji = "▲"; // up triangle
    } else if (ratio < -0.25) {
      label = "Negative";
      emoji = "▼"; // down triangle
    } else {
      label = "Mixed";
      emoji = "◆"; // diamond
    }
  }
  return {
    label,
    emoji,
    positiveHits: pos,
    negativeHits: neg,
    text:
      total === 0
        ? "No strong sentiment signals in the latest results."
        : `${label} lean across recent developer discussion (${pos} positive / ${neg} negative signal words).`,
  };
}

// Pull the most representative opinions out of the matched discussion: split
// snippets into sentences, keep the ones carrying sentiment, dedupe, and return
// the strongest few as bullet points with a polarity marker.
function topSentiments(results, ownTerms, otherTerms, n = 3) {
  const seen = new Set();
  const candidates = [];

  for (const r of results) {
    const text = r.matchText || r.snippet || "";
    const sentences = text.split(/(?<=[.!?])\s+|\s*\|\|\s*/);
    for (const raw of sentences) {
      const s = raw.replace(/\s+/g, " ").trim();
      if (s.length < 25 || s.length > 200) continue;
      if (/^posted by\b|^\d+\s+votes?\b/i.test(s)) continue; // skip reddit metadata
      if (isPromo(s)) continue; // skip the product's own marketing voice
      if (/[{}\[\]]|":|=>|\bnpx\b|\bargs\b/i.test(s)) continue; // skip code/config
      const letters = (s.match(/[a-z]/gi) || []).length;
      if (letters / s.length < 0.6) continue; // skip non-prose (URLs, snippets)

      const low = s.toLowerCase();
      const mentionsOwn = ownTerms.some((t) => termMatches(low, t));
      const mentionsOther = otherTerms.some((t) => termMatches(low, t));
      // Skip opinions clearly about a competitor and not this product.
      if (mentionsOther && !mentionsOwn) continue;

      const { pos, neg } = scoreText(s);
      const weight = pos + neg;
      if (weight === 0) continue; // must carry sentiment

      const key = low.replace(/[^a-z0-9]/g, "").slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);

      const polarity = pos > neg ? "pos" : neg > pos ? "neg" : "mixed";
      // Rank sentences that explicitly name this product ahead of generic ones.
      candidates.push({ text: trimTo(s, 140), weight: weight + (mentionsOwn ? 3 : 0), polarity });
    }
  }

  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, n).map(({ text, polarity }) => ({ text, polarity }));
}

// Trim to a length, cutting on a word boundary and adding an ellipsis.
function trimTo(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max).trim()}…`;
}

// --- Fetch + cache ----------------------------------------------------------

const cache = new Map(); // id -> { data, fetchedAt }

async function searchSite(query, domain) {
  const params = new URLSearchParams({
    query: `${query} site:${domain}`,
    freshness: FRESHNESS,
  });
  const url = `${API_ENDPOINT}?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": API_KEY },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 140)}` : ""}`);
    }

    const json = await res.json();
    return json?.results?.web || [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCompetitor(c) {
  // One query per allowed source, in parallel. If a single source fails we
  // still surface the others rather than failing the whole column.
  let sourcesErrored = false;
  const cutoff = freshnessCutoff();
  const perSource = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const web = await searchSite(c.query, s.domain);
        return web
          .filter((r) => isAllowedHost(r.url))
          // Keep only results within the recency window (see withinWindow).
          .filter((r) => withinWindow(r.page_age, cutoff))
          .map((r) => {
            const snippets = (r.snippets && r.snippets.length
              ? r.snippets
              : [r.description].filter(Boolean));
            return {
              title: r.title || "(untitled)",
              snippet: trimTo(pickSnippet(snippets, c.match), 160),
              matchText: snippets.join(" "), // all snippets, for mention check
              source: s.label,
              host: hostOf(r.url),
              url: r.url,
              pageAge: r.page_age || null,
            };
          })
          // Only keep results that explicitly mention the product, so we don't
          // attribute unrelated chatter to it...
          .filter((r) => mentionsProduct(r, c.match))
          // ...and drop the product's own accounts/orgs — first-party marketing
          // isn't developer sentiment.
          .filter((r) => !isFirstParty(r.url, c.official));
      } catch {
        sourcesErrored = true;
        return [];
      }
    })
  );

  // If a network/API error wiped every source, treat the column as failed.
  if (sourcesErrored && perSource.every((arr) => arr.length === 0)) {
    throw new Error("No results from Reddit, X, or GitHub");
  }

  // Sentiment uses the full merged sample for a stronger signal; the card only
  // displays a top 3 interleaved across sources so each is represented.
  const merged = perSource.flat();
  const topResults = interleave(perSource)
    .slice(0, 3)
    .map(({ matchText, ...rest }) => rest); // drop internal field from payload
  const aspects = aspectCounts(merged);

  return {
    id: c.id,
    name: c.name,
    ok: true,
    results: topResults,
    sampleSize: merged.length,
    sources: SOURCES.map((s, i) => ({ label: s.label, count: perSource[i].length })),
    praise: aspects.positive.slice(0, 6), // most-praised attributes
    gripes: aspects.negative.slice(0, 6), // most-cited concerns
    sentiment: {
      ...summarizeSentiment(merged),
      bullets: topSentiments(merged, c.match, otherMatchTerms(c.id)),
    },
    fetchedAt: new Date().toISOString(),
  };
}

// Round-robin across the per-source result arrays so the top 3 isn't dominated
// by a single platform.
function interleave(arrays) {
  const out = [];
  const max = Math.max(0, ...arrays.map((a) => a.length));
  for (let i = 0; i < max; i++) {
    for (const arr of arrays) {
      if (arr[i]) out.push(arr[i]);
    }
  }
  return out;
}

// Only the canonical hosts count. We deliberately do NOT accept arbitrary
// subdomains — e.g. a vendor's own docs subdomain isn't developer chatter.
function isAllowedHost(u) {
  return ALLOWED_HOSTS.includes(hostOf(u));
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function getCompetitor(c, { force = false } = {}) {
  const cached = cache.get(c.id);
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  try {
    const data = await fetchCompetitor(c);
    cache.set(c.id, { data, fetchedAt: now });
    return { ...data, cached: false };
  } catch (err) {
    // Per-column error state. Serve stale data if we have it, flagged as such.
    const errorPayload = {
      id: c.id,
      name: c.name,
      ok: false,
      error: err.name === "AbortError" ? "Request timed out" : err.message,
      results: [],
      fetchedAt: new Date().toISOString(),
    };
    if (cached) {
      return { ...cached.data, ok: false, stale: true, error: errorPayload.error };
    }
    return errorPayload;
  }
}

// --- Routes -----------------------------------------------------------------

// Cross-product "So what?" — actionable takeaways for product, marketing, and
// engineering, derived entirely from the aggregated numbers so nothing is
// invented: share of voice (mention volume), sentiment leader/laggard, and the
// most common praised attributes / cited concerns across all products.
function buildInsights(columns) {
  const ok = columns.filter((c) => c.ok !== false && (c.sampleSize || 0) > 0);
  if (!ok.length) return null;

  const total = ok.reduce((s, c) => s + c.sampleSize, 0);
  const ratio = (c) => {
    const p = c.sentiment.positiveHits || 0;
    const n = c.sentiment.negativeHits || 0;
    return p + n ? (p - n) / (p + n) : 0;
  };
  const pct = (v) => Math.round((100 * v) / total);

  const byVolume = [...ok].sort((a, b) => b.sampleSize - a.sampleSize);
  const rated = ok.filter((c) => (c.sentiment.positiveHits + c.sentiment.negativeHits) >= 3);
  const byRatio = [...(rated.length ? rated : ok)].sort((a, b) => ratio(b) - ratio(a));
  const topVoice = byVolume[0];
  const leader = byRatio[0];
  const laggard = byRatio[byRatio.length - 1];

  // Aggregate attributes across products, tracking which products cite each.
  const aggP = {};
  const aggN = {};
  const gripeBy = {};
  for (const c of ok) {
    (c.praise || []).forEach(({ word, count }) => (aggP[word] = (aggP[word] || 0) + count));
    (c.gripes || []).forEach(({ word, count }) => {
      aggN[word] = (aggN[word] || 0) + count;
      (gripeBy[word] = gripeBy[word] || new Set()).add(c.name);
    });
  }
  const rank = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const topP = rank(aggP);
  const topN = rank(aggN);
  const list = (a) => (a.length ? a.join(", ") : "—");

  const product = [];
  const marketing = [];
  const engineering = [];

  // --- Marketing: share of voice + narrative ---
  marketing.push(
    `**${topVoice.name}** owns share of voice — ${topVoice.sampleSize} of ${total} in-window mentions (${pct(topVoice.sampleSize)}%).`
  );
  if (topP[0]) {
    marketing.push(
      `Developers frame this category around “${topP[0]}”${topP[1] ? ` and “${topP[1]}”` : ""} — lead positioning there.`
    );
  }
  if (laggard && leader && laggard.id !== leader.id && ratio(laggard) < 0.34) {
    marketing.push(`**${laggard.name}** has the softest sentiment lean — a wedge to position against.`);
  }

  // --- Product: opportunities + benchmark ---
  if (topN[0]) {
    const who = [...(gripeBy[topN[0]] || [])].slice(0, 3).join(", ");
    product.push(
      `Top unmet need: “${topN[0]}”${who ? ` (raised around ${who})` : ""} — a differentiation opportunity.`
    );
  }
  if (leader) {
    const praised = leader.praise && leader.praise[0] ? `praised for “${leader.praise[0].word}”` : "the strongest positive lean";
    product.push(`**${leader.name}** sets the bar (${praised}) — benchmark against it.`);
  }
  const thin = ok.filter((c) => c.sampleSize < 3).map((c) => c.name);
  if (thin.length) {
    product.push(`Thin signal for ${list(thin)} — validate with direct user research before acting.`);
  }

  // --- Engineering: what to build/harden ---
  engineering.push(`Most-valued technical attributes: ${list(topP.slice(0, 3))}.`);
  engineering.push(
    topN.length
      ? `Most-cited problems: ${list(topN.slice(0, 3))} — prioritize in reliability/perf work.`
      : `Few concrete technical complaints surfaced in-window.`
  );
  const friction = [];
  if (topN.includes("slow")) friction.push("latency");
  if (topN.includes("expensive")) friction.push("cost/pricing");
  if (topN.includes("unreliable") || topN.includes("broken")) friction.push("reliability");
  if (friction.length) engineering.push(`Recurring friction on ${list(friction)} — treat as table stakes.`);

  return {
    meta: { topVoice: topVoice.name, leader: leader && leader.name, totalMentions: total },
    product,
    marketing,
    engineering,
  };
}

app.use(express.static(join(__dirname, "public")));

app.get("/api/sentiment", async (req, res) => {
  const force = req.query.refresh === "true";
  if (force) cache.clear();

  const columns = await Promise.all(
    COMPETITORS.map((c) => getCompetitor(c, { force }))
  );

  res.json({
    topic: "Developer sentiment: providing web context to LLMs",
    ttlMinutes: CACHE_TTL_MS / 60000,
    windowMonths: MONTHS_BACK,
    generatedAt: new Date().toISOString(),
    insights: buildInsights(columns),
    columns,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Web-context sentiment dashboard running:`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(
    `  Using ${process.env.YDC_API_KEY ? "YDC_API_KEY from environment" : "fallback API key"}.`
  );
});
