const LIST_PATH_RE = /^\/article_list(\/|$)/i;
const ARTICLE_PATH_RE = /^\/article\/[a-z0-9_-]+\/?$/i;
const ARTICLE_TITLE_SELECTOR = "a.m-article_header_title, .m-article_header_title a";
const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日", "祝"];

const PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];

const state = {
    running: false,
    rows: [],
};

const ui = {
    startUrl: document.getElementById("startUrl"),
    maxPages: document.getElementById("maxPages"),
    maxClinics: document.getElementById("maxClinics"),
    delay: document.getElementById("delay"),
    startBtn: document.getElementById("startBtn"),
    jsonBtn: document.getElementById("jsonBtn"),
    csvBtn: document.getElementById("csvBtn"),
    status: document.getElementById("status"),
    log: document.getElementById("log"),
};

function setStatus(text) {
    ui.status.textContent = text;
}

function log(message) {
    const now = new Date();
    const stamp = now.toLocaleTimeString("ja-JP", { hour12: false });
    ui.log.textContent += `[${stamp}] ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function sleep(sec) {
    if (!sec || sec <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function normalizeUrl(url) {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
}

function cleanText(value) {
    return (value || "")
        .replace(/\s+/g, " ")
        .replace(/^[\s\-]+|[\s\-]+$/g, "")
        .trim();
}

function errText(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    return String(err);
}

function pushUnique(arr, set, value) {
    if (set.has(value)) return;
    set.add(value);
    arr.push(value);
}

async function fetchHtml(url) {
    const res = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}

function toSameHostUrl(baseUrl, href) {
    let abs;
    try {
        abs = new URL(href, baseUrl);
    } catch {
        return null;
    }
    const base = new URL(baseUrl);
    if (abs.host !== base.host) return null;
    return abs;
}

function extractArticleAndListLinks(baseUrl, html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articleLinks = [];
    const listLinks = [];
    const articleSeen = new Set();
    const listSeen = new Set();

    // Top-down order: parse list cards in DOM order.
    doc.querySelectorAll(".m-article-list_item").forEach((item) => {
        const titleAnchor = item.querySelector(ARTICLE_TITLE_SELECTOR) || item.querySelector("a[href]");
        const href = titleAnchor?.getAttribute("href")?.trim();
        if (!href) return;
        const abs = toSameHostUrl(baseUrl, href);
        if (!abs) return;
        if (!ARTICLE_PATH_RE.test(abs.pathname)) return;
        pushUnique(articleLinks, articleSeen, normalizeUrl(abs.href));
    });

    // If card selector misses links, fallback to any article anchors (still in DOM order).
    if (articleLinks.length === 0) {
        doc.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href")?.trim();
            if (!href) return;
            const abs = toSameHostUrl(baseUrl, href);
            if (!abs) return;
            if (!ARTICLE_PATH_RE.test(abs.pathname)) return;
            pushUnique(articleLinks, articleSeen, normalizeUrl(abs.href));
        });
    }

    // Pagination / next list pages in DOM order.
    doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href")?.trim();
        if (!href) return;
        const abs = toSameHostUrl(baseUrl, href);
        if (!abs) return;
        if (!LIST_PATH_RE.test(abs.pathname)) return;
        pushUnique(listLinks, listSeen, normalizeUrl(abs.href));
    });

    return { articleLinks, listLinks };
}

function valueByThLabel(root, label) {
    const rows = Array.from(root.querySelectorAll("tr"));
    for (const tr of rows) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (!th || !td) continue;
        const thText = cleanText(th.textContent);
        if (thText.includes(label)) return cleanText(td.textContent);
    }
    return "";
}

function normalizeScheduleMark(text) {
    const t = cleanText(text);
    if (!t) return "";
    if (/[●○◯〇]/.test(t)) return "●";
    if (/[✕✖×]/.test(t)) return "×";
    if (/[休]/.test(t)) return "休";
    if (/[\-ー－―–—]/.test(t)) return "-";
    return t;
}

function inferMark(cell) {
    const attrs = [
        cell.getAttribute("aria-label") || "",
        cell.getAttribute("title") || "",
        cell.getAttribute("data-status") || "",
        cell.getAttribute("class") || "",
        cell.innerHTML || "",
    ].join(" ");

    if (/(circle|maru|open|available|on)/i.test(attrs)) return "●";
    if (/(cross|close|ng|xmark)/i.test(attrs)) return "×";
    if (/(dash|bar|hyphen|off|holiday|rest)/i.test(attrs)) return "-";
    return "";
}

function parseConsultationHoursFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return "";

    const headCells = Array.from(rows[0].querySelectorAll("th,td"));
    if (headCells.length < 2) return "";

    const headerText = cleanText(rows[0].textContent);
    const hasHoursHeader = headerText.includes("診療時間") || headCells.some((c) => cleanText(c.textContent) === "診療時間");
    if (!hasHoursHeader) return "";

    let dayCols = headCells.slice(1).map((c) => cleanText(c.textContent));
    if (!dayCols.length || dayCols.every((d) => !d)) {
        dayCols = DAY_LABELS.slice(0, headCells.length - 1);
    }

    const lines = [];
    for (const row of rows.slice(1)) {
        const cells = Array.from(row.querySelectorAll("th,td"));
        if (cells.length < 2) continue;

        const timeText = cleanText(cells[0].textContent);
        if (!timeText || timeText.includes("診療時間")) continue;

        const parts = [];
        for (let i = 1; i < cells.length; i += 1) {
            const day = dayCols[i - 1] || DAY_LABELS[i - 1] || `col${i}`;
            let mark = normalizeScheduleMark(cells[i].textContent);
            if (!mark) mark = inferMark(cells[i]);
            if (!mark) mark = "-";
            parts.push(`${day}:${mark}`);
        }
        lines.push(`${timeText} ${parts.join(" ")}`);
    }

    return lines.join(" | ");
}

function extractConsultationHours(block) {
    const tables = Array.from(block.querySelectorAll("table"));
    for (const table of tables) {
        const parsed = parseConsultationHoursFromTable(table);
        if (parsed) return parsed;
    }

    const labelValue = valueByThLabel(block, "診療時間");
    if (labelValue) return labelValue;

    return "";
}

function extractFacilityName(block) {
    const selectors = [
        ".post-clinic-block_title",
        ".post-clinic-block_name",
        ".post-clinic-name",
        ".m-clinic-card_title",
        "h2",
        "h3",
        "h4",
    ];

    for (const sel of selectors) {
        const el = block.querySelector(sel);
        const text = cleanText(el?.textContent || "");
        if (text) return text;
    }

    const firstStrong = cleanText(block.querySelector("strong")?.textContent || "");
    if (firstStrong) return firstStrong;

    return "";
}

function extractHomepage(block, articleUrl) {
    const anchors = Array.from(block.querySelectorAll("a[href]"));

    for (const a of anchors) {
        const txt = cleanText(a.textContent);
        const href = a.getAttribute("href")?.trim();
        if (!href) continue;
        let abs;
        try {
            abs = new URL(href, articleUrl).href;
        } catch {
            continue;
        }
        if (/(公式|ホームページ|HP)/i.test(txt)) return abs;
    }

    for (const a of anchors) {
        const href = a.getAttribute("href")?.trim();
        if (!href) continue;
        let abs;
        try {
            abs = new URL(href, articleUrl);
        } catch {
            continue;
        }
        if (/^https?:/i.test(abs.protocol)) return abs.href;
    }

    return "";
}

function extractPhone(block) {
    const labelPhone = valueByThLabel(block, "電話番号");
    if (labelPhone) return labelPhone;

    const txt = cleanText(block.textContent);
    const m = txt.match(/0\d{1,4}-\d{1,4}-\d{3,4}/);
    if (m) return m[0];

    return "";
}

function extractPrefecture(doc, title) {
    for (const pref of PREFECTURES) {
        if (title.includes(pref)) return pref;
    }
    const anchors = Array.from(doc.querySelectorAll("a"));
    for (const a of anchors) {
        const txt = cleanText(a.textContent);
        if (PREFECTURES.includes(txt)) return txt;
    }
    const bodyText = doc.body?.textContent || "";
    for (const pref of PREFECTURES) {
        if (bodyText.includes(`「${pref}・`)) return pref;
    }
    return "";
}

function extractArea(title) {
    const m = title.match(/(?:】|\]|\[|【|\s|^)([^】\]\[【\s]+?[市区郡町村])/);
    if (m && m[1].length <= 15) {
        let area = m[1].replace(/^[^\w\u3040-\u30FF\u4E00-\u9FFF]+/, "");
        for (const pref of PREFECTURES) {
            if (area.startsWith(pref) && area !== pref) {
                area = area.substring(pref.length);
            }
        }
        return area;
    }
    return "";
}

function extractHeadingTitle(doc) {
    const el =
        doc.querySelector(".heading__title") ||
        doc.querySelector("[class*='heading__title']");
    return cleanText(el?.textContent || "");
}

function extractClinicsFromArticleHtml(html, articleUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articleTitle = cleanText(doc.querySelector(".m-article_header .m-article_header_title, .m-article_header_title, h1")?.textContent || "");

    // ★ 追加
    const headingTitle = extractHeadingTitle(doc);

    const prefecture = extractPrefecture(doc, articleTitle);
    const area = extractArea(articleTitle);

    const blocks = Array.from(doc.querySelectorAll(".post-clinic-block"));
    const rows = [];

    blocks.forEach((block, index) => {
        rows.push({
            heading_title: headingTitle,  // ★ 追加（一番左の列）
            area: area,
            prefecture: prefecture,
            article_url: articleUrl,
            article_title: articleTitle,
            facility_name: extractFacilityName(block),
            homepage: extractHomepage(block, articleUrl),
            phone: extractPhone(block),
            consultation_hours: extractConsultationHours(block),
            block_index: index + 1,
        });
    });

    return rows;
}

async function discoverArticlePages(startUrl, maxPages, delaySec) {
    const queue = [normalizeUrl(startUrl)];
    const queuedSet = new Set(queue);
    const visitedListPages = new Set();
    const articlePages = [];
    const articleSeen = new Set();

    while (queue.length && visitedListPages.size < maxPages) {
        const url = queue.shift();
        if (!url || visitedListPages.has(url)) continue;
        visitedListPages.add(url);

        setStatus(`一覧ページ巡回: ${visitedListPages.size}/${maxPages}`);
        log(`一覧取得: ${url}`);

        let html;
        try {
            html = await fetchHtml(url);
        } catch (err) {
            log(`WARN 一覧取得失敗: ${url} (${errText(err)})`);
            continue;
        }

        const { articleLinks, listLinks } = extractArticleAndListLinks(url, html);

        articleLinks.forEach((u) => {
            pushUnique(articlePages, articleSeen, u);
        });

        listLinks.forEach((u) => {
            if (visitedListPages.has(u) || queuedSet.has(u)) return;
            queue.push(u);
            queuedSet.add(u);
        });

        await sleep(delaySec);
    }

    return articlePages;
}

function encodeCsvField(value) {
    const text = value == null ? "" : String(value);
    if (text.includes('"') || text.includes(",") || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function toCsv(rows) {
    const headers = [
        "heading_title",   // ★ 追加（一番左の列）
        "area",
        "prefecture",
        "article_url",
        "article_title",
        "facility_name",
        "homepage",
        "phone",
        "consultation_hours",
        "block_index",
    ];

    const lines = [headers.join(",")];
    rows.forEach((row) => {
        lines.push(headers.map((h) => encodeCsvField(row[h] ?? "")).join(","));
    });
    return `\uFEFF${lines.join("\n")}`;
}

function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);

    chrome.downloads.download(
        {
            url: objectUrl,
            filename,
            saveAs: true,
        },
        () => setTimeout(() => URL.revokeObjectURL(objectUrl), 1000),
    );
}

async function runScrape() {
    if (state.running) return;

    const startUrl = ui.startUrl.value.trim();
    const maxPages = Number(ui.maxPages.value) || 80;
    const maxClinics = Number(ui.maxClinics.value) || 0;
    const delaySec = Number(ui.delay.value) || 0;

    try {
        new URL(startUrl);
    } catch {
        alert("開始URLが不正です。");
        return;
    }

    state.running = true;
    state.rows = [];
    ui.startBtn.disabled = true;
    ui.jsonBtn.disabled = true;
    ui.csvBtn.disabled = true;
    ui.log.textContent = "";

    log("スクレイピング開始");

    try {
        const articleUrls = await discoverArticlePages(startUrl, maxPages, delaySec);
        log(`記事ページ発見: ${articleUrls.length}件`);

        const rows = [];
        for (let i = 0; i < articleUrls.length; i += 1) {
            const articleUrl = articleUrls[i];
            setStatus(`記事解析中: ${i + 1}/${articleUrls.length}`);
            log(`記事取得: ${articleUrl}`);

            try {
                const html = await fetchHtml(articleUrl);
                const extracted = extractClinicsFromArticleHtml(html, articleUrl);
                extracted.forEach((r) => rows.push(r));
                log(`post-clinic-block抽出: ${extracted.length}件`);
            } catch (err) {
                log(`WARN 記事取得失敗: ${articleUrl} (${errText(err)})`);
            }

            if (maxClinics > 0 && rows.length >= maxClinics) {
                break;
            }

            await sleep(delaySec);
        }

        state.rows = maxClinics > 0 ? rows.slice(0, maxClinics) : rows;
        setStatus(`完了: ${state.rows.length}件`);
        log(`完了: ${state.rows.length}件`);
        ui.jsonBtn.disabled = state.rows.length === 0;
        ui.csvBtn.disabled = state.rows.length === 0;
    } catch (err) {
        setStatus("エラーで停止しました");
        log(`ERROR: ${errText(err)}`);
    } finally {
        state.running = false;
        ui.startBtn.disabled = false;
    }
}

ui.startBtn.addEventListener("click", runScrape);

ui.jsonBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    downloadText(
        `mynavi_article_clinics_${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(state.rows, null, 2),
        "application/json;charset=utf-8",
    );
});

ui.csvBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    downloadText(
        `mynavi_article_clinics_${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(state.rows),
        "text/csv;charset=utf-8",
    );
});
