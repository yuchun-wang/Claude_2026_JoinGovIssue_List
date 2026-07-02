// 渲染邏輯 + 關鍵字篩選 + 排序 + 狀態篩選 + 進站即時向來源網站核對資料是否有變動

const knownIds = new Set(ISSUES.map(i => i.id));
let liveData = null; // /api/refresh 回傳的 { checkedAt, items: {id: {...}} }

// 即時發現的新議題，若狀態屬於這些「還沒有結果」的類別才值得顯示，
// 已經失敗／被駁回／撤回的舊案不需要當成「新發現」推播出來
const NEW_ISSUE_VISIBLE_STATUSES = new Set([
  "Ready", "Proposing", "Adjusted", "FirstSigned", "SecondSigned", "Completed", "Advice",
]);

// 排序時「狀態」欄位的優先順序（數字越小排越前面）
const STATUS_SORT_ORDER = [
  "FirstSigned", "SecondSigned", "Proposing", "Adjusted", "Ready",
  "Completed", "Advice", "SecondFailed", "FirstFailed", "Rejected", "Revoked",
];

function detailUrl(id) {
  return "https://join.gov.tw/idea/detail/" + id;
}

function statusInfo(rawStatus) {
  return STATUS_MAP[rawStatus] || { bucket: "active", label: rawStatus || "狀態未知" };
}

function autoCategory(title) {
  for (const [catId, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(k => title.includes(k))) return catId;
  }
  return "other";
}

// 統一把「已整理議題」跟「即時抓到的新議題」都轉成同一種顯示用格式
function resolveCuratedDisplay(issue) {
  const live = liveData && liveData.items[issue.id];
  const rawStatus = live ? live.status : issue.rawStatus;
  const info = statusInfo(rawStatus);
  const endorseCount = live ? live.endorseCount : issue.endorseCount;
  const changed = !!live && (live.status !== issue.rawStatus || live.endorseCount !== issue.endorseCount);
  return {
    kind: "curated",
    id: issue.id,
    title: issue.title,
    desc: issue.desc,
    pros: issue.pros,
    cons: issue.cons,
    bucket: info.bucket,
    statusLabel: info.label,
    rawStatus,
    endorseCount,
    publishDate: live && live.publishDate ? live.publishDate : issue.publishDate,
    changed,
  };
}

function resolveNewDisplay(item) {
  const info = statusInfo(item.status);
  return {
    kind: "new",
    id: item.id,
    title: item.title,
    bucket: info.bucket,
    statusLabel: info.label,
    rawStatus: item.status,
    endorseCount: item.endorseCount || 0,
    publishDate: item.publishDate || null,
    changed: false,
  };
}

function matchesQuery(display, query) {
  if (!query) return true;
  const haystack = [display.title, display.desc || "", ...(display.pros || []), ...(display.cons || [])]
    .join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function matchesStatusFilter(display, filter) {
  if (filter === "all") return true;
  if (filter === "active") return display.bucket === "active";
  if (filter === "responded") return display.rawStatus === "Completed" || display.rawStatus === "Advice";
  if (filter === "closed") return display.bucket === "completed" && display.rawStatus !== "Completed" && display.rawStatus !== "Advice";
  return true;
}

function sortDisplays(list, sortBy) {
  const sorted = list.slice();
  if (sortBy === "endorse") {
    sorted.sort((a, b) => b.endorseCount - a.endorseCount);
  } else if (sortBy === "time") {
    sorted.sort((a, b) => (b.publishDate || 0) - (a.publishDate || 0));
  } else if (sortBy === "status") {
    sorted.sort((a, b) => {
      const ai = STATUS_SORT_ORDER.indexOf(a.rawStatus);
      const bi = STATUS_SORT_ORDER.indexOf(b.rawStatus);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }
  return sorted;
}

function cardHTML(display) {
  const isActive = display.bucket === "active";
  const isNew = display.kind === "new";

  const descBlock = isNew
    ? `<p class="desc">🆕 這是即時檢查時，從 join.gov.tw 新發現、標題與女性權益相關字詞相符的議題。系統依關鍵字自動歸類到本分類，尚未經人工整理摘要與正反方意見，請點擊查看原提案全文。</p>`
    : `<p class="desc">${display.desc}</p>`;

  const stanceBlock = isNew
    ? ""
    : `
      <div class="stance-grid">
        <div class="stance pro">
          <div class="stance-label">👍 正方意見</div>
          <ul>${display.pros.map(p => `<li>${p}</li>`).join("")}</ul>
        </div>
        <div class="stance con">
          <div class="stance-label">👎 反方意見</div>
          <ul>${display.cons.map(c => `<li>${c}</li>`).join("")}</ul>
        </div>
      </div>`;

  return `
    <div class="card ${isNew ? "new-card" : ""}" data-id="${display.id}">
      <div class="card-top">
        <h3>${isNew ? "🆕 " : ""}${display.title}</h3>
        <span class="badge ${display.bucket}">${display.statusLabel}</span>
      </div>
      <div class="endorse-count">
        目前附議 / 關注人數：${display.endorseCount.toLocaleString()}
        ${display.changed ? `<span class="live-tag" title="已與 join.gov.tw 目前資料同步更新">🔄 已同步最新資料</span>` : ""}
      </div>
      ${descBlock}
      ${stanceBlock}
      <div class="card-actions">
        <a class="btn ${isActive ? "primary" : "secondary"}" href="${detailUrl(display.id)}" target="_blank" rel="noopener">
          ${isActive ? "✍️ 前往連署" : "查看提案" + (isNew ? "" : "與官方回應")} →
        </a>
      </div>
    </div>
  `;
}

function getState() {
  return {
    query: document.getElementById("searchInput").value.trim(),
    sortBy: document.getElementById("sortSelect").value,
    statusFilter: document.getElementById("statusFilterSelect").value,
  };
}

function render() {
  const { query, sortBy, statusFilter } = getState();
  const main = document.getElementById("main");
  main.innerHTML = "";
  let totalShown = 0;

  const newItemsByCategory = {};
  if (liveData) {
    Object.values(liveData.items)
      .filter(it => !knownIds.has(it.id))
      .filter(it => NEW_ISSUE_VISIBLE_STATUSES.has(it.status))
      .filter(it => TITLE_KEYWORDS.some(k => it.title.includes(k)))
      .forEach(it => {
        const cat = autoCategory(it.title);
        (newItemsByCategory[cat] = newItemsByCategory[cat] || []).push(it);
      });
  }

  CATEGORIES.forEach(cat => {
    const curatedDisplays = ISSUES.filter(i => i.category === cat.id).map(resolveCuratedDisplay);
    const newDisplays = (newItemsByCategory[cat.id] || []).map(resolveNewDisplay);

    let displays = [...curatedDisplays, ...newDisplays]
      .filter(d => matchesQuery(d, query))
      .filter(d => matchesStatusFilter(d, statusFilter));

    if (displays.length === 0) return;
    displays = sortDisplays(displays, sortBy);
    totalShown += displays.length;

    const section = document.createElement("section");
    section.className = "category";
    section.id = cat.id;
    section.innerHTML = `<h2>${cat.name}<span class="count-pill">${displays.length}</span></h2>`
      + displays.map(cardHTML).join("");
    main.appendChild(section);
  });

  if (totalShown === 0) {
    main.innerHTML = `<p class="empty-state">沒有符合條件的議題，換個關鍵字或篩選條件試試看？</p>`;
  }
}

function buildNav() {
  const nav = document.getElementById("categoryNav");
  nav.innerHTML = "";
  CATEGORIES.forEach(cat => {
    const link = document.createElement("a");
    link.href = "#" + cat.id;
    link.textContent = cat.name;
    nav.appendChild(link);
  });
}

function setSyncStatus(html, cls) {
  const el = document.getElementById("syncStatus");
  el.className = "sync-status " + (cls || "");
  el.innerHTML = html;
}

function formatCheckedAt(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-TW", { hour12: false });
  } catch (e) {
    return iso;
  }
}

async function refreshFromSource(force) {
  setSyncStatus("🔄 正在向 join.gov.tw 核對最新資料…", "checking");
  try {
    const res = await fetch("/api/refresh" + (force ? "?force=1" : ""), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    liveData = data;
    render();

    const cacheNote = data.fromCache
      ? `（使用 ${Math.round(data.cacheAgeSeconds / 60)} 分鐘前的快取，避免頻繁打擾來源網站）`
      : "（剛剛即時抓取）";
    setSyncStatus(
      `✅ 已於 ${formatCheckedAt(data.checkedAt)} 核對來源網站 ${cacheNote}　`
      + `<button id="forceRefreshBtn" class="link-btn">立即強制重新檢查</button>`,
      "ok"
    );
    document.getElementById("forceRefreshBtn").addEventListener("click", () => refreshFromSource(true));
  } catch (e) {
    setSyncStatus(
      `⚠️ 無法即時連線來源網站，目前顯示的是最後一次人工整理的靜態資料。`
      + `如需啟用即時核對，請在此資料夾執行 <code>python3 server.py</code>，再用 `
      + `<code>http://localhost:8787</code> 開啟本頁。`,
      "warn"
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  buildNav();
  render();

  document.getElementById("searchInput").addEventListener("input", render);
  document.getElementById("sortSelect").addEventListener("change", render);
  document.getElementById("statusFilterSelect").addEventListener("change", render);

  refreshFromSource(false);
});
