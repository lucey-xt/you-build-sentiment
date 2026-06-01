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

// Sentiment is sampled ONLY from these developer communities. Each competitor
// query is run once per domain (via a `site:` filter) and the results merged,
// so every card draws on Reddit, X, and GitHub chatter.
const SOURCES = [
  { domain: "reddit.com", label: "Reddit" },
  { domain: "x.com", label: "X" },
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
const COMPETITORS = [
  {
    id: "youcom",
    name: "You.com",
    query:
      "You.com search API developer experience providing web context to LLMs grounding",
    match: ["you.com", "youchat", "ydc-index", "you.com api"],
  },
  {
    id: "tavily",
    name: "Tavily",
    query:
      "Tavily search API developer experience web context for LLMs RAG grounding review",
    match: ["tavily"],
  },
  {
    id: "exa",
    name: "Exa",
    query:
      "Exa AI search API developer experience web context for LLMs RAG review",
    match: ["exa.ai", "exa ai", "exa api", "exa search", "metaphor systems"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    query:
      "Perplexity Sonar API developer experience web search context for LLMs review",
    match: ["perplexity", "sonar api"],
  },
  {
    id: "brave",
    name: "Brave Search API",
    query:
      "Brave Search API developer experience web context for LLMs grounding RAG review",
    match: ["brave search", "brave api", "brave's search"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    query:
      "Firecrawl developer experience scraping web content as context for LLMs review",
    match: ["firecrawl"],
  },
];

function termMatches(text, term) {
  const t = term.toLowerCase();
  if (/[^a-z0-9]/.test(t)) return text.includes(t); // dotted/multi-word -> substring
  return new RegExp(`\\b${t}\\b`).test(text); // single word -> word boundary
}

// True when one of the product's `match` terms appears anywhere in the result
// (title, ANY snippet, or URL). Reddit snippets often lead with vote-count
// metadata, so the mention may sit in a later snippet than the displayed one.
function mentionsProduct(result, matchTerms) {
  const hay = `${result.title} ${result.matchText} ${result.url}`.toLowerCase();
  return matchTerms.some((term) => termMatches(hay, term));
}

// Choose the snippet to display: prefer one that actually names the product
// (more informative than "Posted by u/… - 9 votes"), else fall back to the first.
function pickSnippet(snippets, matchTerms) {
  const named = snippets.find((sn) =>
    matchTerms.some((term) => termMatches(sn.toLowerCase(), term))
  );
  return named || snippets[0] || "";
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

function scoreText(text) {
  const words = (text || "").toLowerCase().match(/[a-z']+/g) || [];
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE.includes(w)) pos++;
    if (NEGATIVE.includes(w)) neg++;
  }
  return { pos, neg };
}

function summarizeSentiment(results) {
  let pos = 0;
  let neg = 0;
  for (const r of results) {
    // Score the full snippet text (richer than the single displayed snippet).
    const s = scoreText(`${r.title} ${r.matchText || r.snippet}`);
    pos += s.pos;
    neg += s.neg;
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

// --- Fetch + cache ----------------------------------------------------------

const cache = new Map(); // id -> { data, fetchedAt }

async function searchSite(query, domain) {
  const url = `${API_ENDPOINT}?query=${encodeURIComponent(`${query} site:${domain}`)}`;
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
  const perSource = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const web = await searchSite(c.query, s.domain);
        return web
          .filter((r) => isAllowedHost(r.url))
          .map((r) => {
            const snippets = (r.snippets && r.snippets.length
              ? r.snippets
              : [r.description].filter(Boolean));
            return {
              title: r.title || "(untitled)",
              snippet: pickSnippet(snippets, c.match),
              matchText: snippets.join(" "), // all snippets, for mention check
              source: s.label,
              host: hostOf(r.url),
              url: r.url,
            };
          })
          // Only keep results that explicitly mention the product, so we don't
          // attribute unrelated chatter to it.
          .filter((r) => mentionsProduct(r, c.match));
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

  return {
    id: c.id,
    name: c.name,
    ok: true,
    results: topResults,
    sampleSize: merged.length,
    sources: SOURCES.map((s, i) => ({ label: s.label, count: perSource[i].length })),
    sentiment: summarizeSentiment(merged),
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

function isAllowedHost(u) {
  const h = hostOf(u);
  return ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
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
    generatedAt: new Date().toISOString(),
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
