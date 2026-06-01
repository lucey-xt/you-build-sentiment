# Web-Context-for-LLMs — Developer Sentiment Dashboard

A small dashboard that tracks **developer sentiment about products that provide context from the web to LLMs** (web search / grounding / scraping APIs). It samples discussion from **Reddit, X, and GitHub** via the [You.com Search API](https://api.you.com) and renders one column per product.

![one column per product, each with a sentiment badge, source breakdown, and top results](https://img.shields.io/badge/stack-Node%20%2B%20Express%20%2B%20vanilla%20JS-5368EE)

## What it tracks

Each product gets a card showing:

- **Sentiment badge** — Positive / Mixed / Neutral / Negative, derived from a lightweight lexical score over the matched discussion.
- **Source breakdown** — how many explicit mentions came from Reddit, X, and GitHub.
- **Top 3 results** — title, snippet, source platform, and a link to the original post.
- **Fetch timestamp** — and whether the data was served from cache.

Products currently tracked: **You.com, Tavily, Exa, Perplexity, Brave Search API, Firecrawl.**

## How it works

- The server runs one query **per source** (`site:reddit.com`, `site:news.ycombinator.com`, `site:producthunt.com`, `site:github.com`) for each product, in parallel, against `https://ydc-index.io/v1/search`.
- Results are **hard-filtered to those canonical domains** (exact host only — no vendor doc subdomains), then **filtered again so the product is explicitly mentioned** (in the title, any snippet, or the URL) before it counts toward that product's sentiment. This keeps generic "best search API?" threads from being attributed to every product. The product's own accounts/orgs and first-party marketing copy are also excluded so self-promotion isn't counted as developer sentiment.
- **Recency:** calls send `freshness=year` and results are then filtered client-side to the **last 6 months** using each result's reported date (`MONTHS_BACK` in `server.js`). Items without a reported date are kept (the API's `freshness=year` already bounds them). *(X was dropped as a source: within the window the index surfaces almost no third-party developer sentiment there for these tools — mostly the products' own accounts.)*
- Sentiment is scored server-side over the full matched sample; each card shows the 3 most representative opinions as bullets plus an interleaved top 3 of results so no single platform dominates.
- Results are cached in memory for **15 minutes**. The **Refresh** button clears the cache and re-fetches. If a single source fails, the column still renders from the others; a column only errors if all sources fail.
