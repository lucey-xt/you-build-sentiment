const grid = document.getElementById("grid");
const sowhatEl = document.getElementById("sowhat");
const refreshBtn = document.getElementById("refresh");
const metaEl = document.getElementById("meta");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDate(iso) {
  if (!iso) return "date n/a";
  const d = new Date(iso);
  if (isNaN(d)) return "date n/a";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Escape, then render **bold** spans (the only markup used in takeaways).
function fmtRich(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const SOWHAT_SECTIONS = [
  { key: "product", label: "Product", icon: "◆" },
  { key: "marketing", label: "Marketing", icon: "◇" },
  { key: "engineering", label: "Engineering", icon: "▣" },
];

function renderInsights(insights) {
  if (!insights) {
    sowhatEl.innerHTML = "";
    return;
  }
  const cards = SOWHAT_SECTIONS.map((sec) => {
    const items = insights[sec.key] || [];
    const lis = items.map((t) => `<li>${fmtRich(t)}</li>`).join("");
    return `
      <div class="sowhat-card ${sec.key}">
        <div class="sowhat-head"><span class="sowhat-icon">${sec.icon}</span>${sec.label}</div>
        <ul>${lis || '<li class="muted">No clear signal yet.</li>'}</ul>
      </div>`;
  }).join("");

  sowhatEl.innerHTML = `
    <div class="sowhat-title">
      <h2>So what?</h2>
      <span class="sowhat-sub">Cross-product takeaways from ${insights.meta?.totalMentions ?? 0} developer mentions</span>
    </div>
    <div class="sowhat-grid">${cards}</div>`;
}

function renderResult(r) {
  return `
    <li class="result">
      <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
      <p class="snippet">${esc(r.snippet)}</p>
      <span class="source">${esc(r.source || "unknown source")} · ${esc(fmtDate(r.pageAge))}</span>
    </li>`;
}

function renderCard(col) {
  if (!col.ok && !col.stale) {
    return `
      <div class="card">
        <div class="card-head"><h2>${esc(col.name)}</h2>
          <span class="badge Negative">Error</span>
        </div>
        <div class="error-box">⚠ ${esc(col.error || "Failed to load results.")}</div>
        <div class="timestamp">Attempted ${fmtTime(col.fetchedAt)}</div>
      </div>`;
  }

  const s = col.sentiment || { label: "Neutral", emoji: "➖", text: "", bullets: [] };
  const staleNote = col.stale
    ? `<div class="stale-note">⚠ Showing cached data — last refresh failed (${esc(col.error || "")}).</div>`
    : "";

  const polarityMark = { pos: "+", neg: "–", mixed: "~" };
  const bullets = s.bullets || [];
  const summaryHtml = bullets.length
    ? `<ul class="summary">${bullets
        .map(
          (b) =>
            `<li class="b-${esc(b.polarity)}"><span class="mark">${polarityMark[b.polarity] || "•"}</span>${esc(b.text)}</li>`
        )
        .join("")}</ul>`
    : `<p class="sentiment-text">${esc(s.text)}</p>`;

  const resultsHtml = (col.results || []).map(renderResult).join("");
  const sourcesHtml = (col.sources || [])
    .map((src) => `<span class="src-chip">${esc(src.label)} ${src.count}</span>`)
    .join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(col.name)}</h2>
        <span class="badge ${esc(s.label)}">${s.emoji} ${esc(s.label)}</span>
      </div>
      <div class="summary-label">Top sentiments</div>
      ${summaryHtml}
      <div class="sources">${sourcesHtml}</div>
      ${staleNote}
      <ul class="results">${resultsHtml || '<li class="skeleton">No results returned.</li>'}</ul>
      <div class="timestamp">Fetched ${fmtTime(col.fetchedAt)}${col.cached ? " · cached" : ""}</div>
    </div>`;
}

function renderSkeleton() {
  grid.innerHTML = Array.from({ length: 6 })
    .map(
      () => `<div class="card"><div class="skeleton">Loading…</div></div>`
    )
    .join("");
}

async function load({ refresh = false } = {}) {
  refreshBtn.disabled = true;
  refreshBtn.textContent = refresh ? "Refreshing…" : "Loading…";
  if (!grid.children.length || refresh) renderSkeleton();

  try {
    const res = await fetch(`/api/sentiment${refresh ? "?refresh=true" : ""}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();

    renderInsights(data.insights);
    grid.innerHTML = data.columns.map(renderCard).join("");
    const windowNote = data.windowMonths ? `last ${data.windowMonths} months · ` : "";
    metaEl.textContent = `${windowNote}${data.columns.length} products · ${data.ttlMinutes}-min cache · updated ${fmtTime(
      data.generatedAt
    )}`;
  } catch (err) {
    grid.innerHTML = `<div class="card"><div class="error-box">⚠ Could not reach the server: ${esc(
      err.message
    )}</div></div>`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

refreshBtn.addEventListener("click", () => load({ refresh: true }));
load();
