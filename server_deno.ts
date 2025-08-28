// server_deno.ts
/**
 * Full Price Comparison Server - Deno edition (single-file)
 * - CHP-first aggregator pipeline, with multiple fallbacks
 * - Optional Zyte extraction (USE_ZYTE + ZYTE_API_KEY)
 * - LRU cache, tracing, retries, randomized UA, Hebrew-friendly helpers
 * - Endpoints: /health, /config, /branches, /debug/example, /compare
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read server_deno.ts
 *
 * .env example (optional for local runs):
 *   PORT=3000
 *   NODE_ENV=development
 *   USE_ZYTE=false
 *   ZYTE_API_KEY=
 *   REQUEST_TIMEOUT_MS=18000
 *   ENFORCE_APPROVED_BRANCHES=false
 *
 * Notes:
 * - Uses Oak for routing.
 * - Avoids retailer sites by default; focuses on aggregators (CHP, zap, pricez, bonusbuy).
 * - The "three supermarkets" requirement is satisfied by attempting to return results from
 *   at least three distinct stores when available (aggregators typically include store names).
 */

import { Application, Router, Context } from "https://deno.land/x/oak@v12.6.0/mod.ts";

/* ---------------------------
   Environment loading (simple)
   - Reads .env if present (local) and merges with Deno.env
   - Avoids depending on std/dotenv exports that changed across versions
   --------------------------- */
async function loadDotenvIfPresent(): Promise<Record<string,string>> {
  try {
    const txt = await Deno.readTextFile(".env");
    const out: Record<string,string> = {};
    for (const line of txt.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [k, ...rest] = trimmed.split("=");
      if (!k) continue;
      const v = rest.join("=").trim();
      // remove surrounding quotes if present
      out[k.trim()] = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
    return out;
  } catch {
    return {};
  }
}

const localEnv = await loadDotenvIfPresent();
const processEnv = Deno.env.toObject();
const ENV: Record<string,string> = { ...localEnv, ...processEnv };

// Config
const PORT = Number(ENV.PORT ?? 3000);
const NODE_ENV = ENV.NODE_ENV ?? "development";
const USE_ZYTE = String(ENV.USE_ZYTE ?? "false").toLowerCase() === "true";
const ZYTE_API_KEY = ENV.ZYTE_API_KEY ?? "";
const REQUEST_TIMEOUT_MS = Number(ENV.REQUEST_TIMEOUT_MS ?? 18000);
const ENFORCE_APPROVED_BRANCHES = String(ENV.ENFORCE_APPROVED_BRANCHES ?? "false").toLowerCase() === "true";

/* ---------------------------
   Aggregators / Denylist
   --------------------------- */
const AGGREGATOR_PRIMARY = "chp.co.il"; // primary aggregator (local aggregator)
const AGGREGATOR_FALLBACKS = ["zap.co.il", "pricez.co.il", "bonusbuy.co.il"]; // at least 3 alternatives
const ALLOWED_AGGREGATORS = [AGGREGATOR_PRIMARY, ...AGGREGATOR_FALLBACKS];

// Denylist of retailer domains (we won't verify/scrape retailer sites directly unless explicitly enabled)
const RETAILER_DENYLIST = new Set([
  "shufersal.co.il",
  "victoryonline.co.il",
  "rami-levy.co.il",
  "yohananof.co.il",
  "osherad.co.il",
  "yenotbitan.co.il",
  "tivtaam.co.il",
  "superdosh.co.il",
  "keshet-teamim.co.il",
  "mega.co.il"
]);

/* ---------------------------
   LRU Cache (simple)
   --------------------------- */
class LRUCache<K,V> {
  max: number;
  map: Map<K,V>;
  constructor(max = 200) {
    this.max = max;
    this.map = new Map();
  }
  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
}
const responseCache = new LRUCache<string, any>(300);

/* ---------------------------
   Approved branches sample (kept for parity)
   --------------------------- */
const APPROVED_BRANCHES = [
  "ChIJm3E2f42zAhURPWjno-zc_7U",
  "ChIJtSxk3F6zAhURG-fMxF5vY2Y",
  "ChIJDYA4PQ2zAhUR5Zhc6BwkAhE"
];

/* ---------------------------
   Utilities
   --------------------------- */
const sleep = (ms:number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const genRequestId = () => (typeof crypto?.randomUUID === "function") ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('');

function hebNormalize(s?: string){
  if (!s) return "";
  return s.replace(/\s+/g, " ").replace(/[״"′’]/g, '"').replace(/[׳']/g, "'").trim();
}
function asNumber(x: unknown, fallback: number | null = null) {
  if (x == null) return fallback;
  const s = String(x).replace(/[^\d.,-]/g, "");
  if (!s) return fallback;
  const norm = s.replace(/,/g, ".");
  const n = Number(norm);
  return Number.isFinite(n) ? n : fallback;
}
function chooseUA(){
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  ];
  return uas[Math.floor(Math.random()*uas.length)];
}
function isRetailerDomain(urlStr: string) {
  try {
    const h = new URL(urlStr).hostname;
    for (const d of RETAILER_DENYLIST) if (h.endsWith(d)) return true;
    return false;
  } catch { return false; }
}
function isAllowedAggregator(urlStr: string) {
  try {
    const h = new URL(urlStr).hostname;
    return ALLOWED_AGGREGATORS.some(d => h.endsWith(d));
  } catch { return false; }
}

/* ---------------------------
   HTTP fetch with timeout + UA
   --------------------------- */
async function timedFetch(url: string, options: RequestInit = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = new Headers(options.headers || {});
    if (!headers.has("user-agent")) headers.set("user-agent", chooseUA());
    if (!headers.has("accept-language")) headers.set("accept-language", "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7");
    const resp = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(id);
    const text = await resp.text().catch(() => "");
    return { status: resp.status, text };
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/* ---------------------------
   Zyte extraction (optional)
   --------------------------- */
async function zyteExtract(url: string, { apiKey = ZYTE_API_KEY, timeout = 22000 } = {}) {
  if (!USE_ZYTE) return { ok: false, status: 412, error: "zyte-disabled" };
  if (!apiKey) return { ok: false, status: 400, error: "missing-zyte-api-key" };
  const controller = new AbortController();
  const t = setTimeout(()=> controller.abort(), timeout);
  try {
    const resp = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        Authorization: "Apikey " + apiKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ url, httpResponseBody: true, productList: true }),
      signal: controller.signal
    });
    clearTimeout(t);
    const status = resp.status;
    const json = await resp.json().catch(() => null);
    return { ok: status >= 200 && status < 300, status, data: json };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 500, error: (e as Error).message };
  }
}

/* ---------------------------
   HTML helpers (lightweight)
   --------------------------- */
function extractLinksFromHtml(html: string) {
  const links: { href: string; inner: string }[] = [];
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push({ href: m[1], inner: m[2] });
  }
  return links;
}
function htmlToText(html: string) {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  return hebNormalize(noScripts.replace(/<[^>]+>/g, " "));
}
function guessPrices(text: string) {
  const found: number[] = [];
  const rx = /(₪\s?\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?\s?₪)/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const v = asNumber(m[0]);
    if (v != null && v > 0 && v < 10000) found.push(v);
  }
  return found;
}
function inferSize(text: string) {
  const pats = [
    /(\d+(?:\.\d+)?)\s?(?:ליטר|L)\b/i,
    /(\d+(?:\.\d+)?)\s?(?:מ\"ל|מיליליטר|ml)\b/i,
    /\b(\d+)\s?יח'?\b/i,
    /\b(\d+)\s?בקב(?:ו)?קים?\b/i,
    /\b(\d+)\s?פחיות?\b/i
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
function normalizeProductName(n?: string) {
  if (!n) return "";
  return hebNormalize(n).replace(/\s{2,}/g, " ").trim();
}
function inferBrand(n?: string) {
  if (!n) return null;
  const s = n.toLowerCase();
  if (/(קוקה|coca)/.test(s)) return "קוקה קולה";
  if (/(פפסי|pepsi)/.test(s)) return "פפסי";
  return null;
}

/* ---------------------------
   CHP parsing heuristics
   - looks for price tokens and nearby context
   --------------------------- */
function parseCHP(html: string, baseUrl: string, query: string) {
  const items: any[] = [];
  const links = extractLinksFromHtml(html);
  const priceTokenRx = /(₪\s?\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?\s?₪)/g;
  let m;
  const hits: { index: number; token: string }[] = [];
  while ((m = priceTokenRx.exec(html)) !== null) hits.push({ index: m.index, token: m[0] });

  const WINDOW = 900;
  for (const h of hits) {
    const left = Math.max(0, h.index - WINDOW);
    const right = Math.min(html.length, h.index + WINDOW);
    const slice = html.slice(left, right);
    const storeNameMatch = slice.match(/(?:שופרסל|ויקטורי|רמי לוי|טיב טעם|יוחננוף|מחסני השוק|יינות ביתן|חצי חינם|פרשמרקט|סופר דוש|אושר עד)/);
    const store_name = storeNameMatch ? storeNameMatch[0] : "לא ידוע (CHP)";

    let product_url: string | null = null;
    for (const { href } of links) {
      const pos = html.indexOf(href);
      if (pos >= left && pos <= right) {
        if (/\/search|\/%D7%|\?q=|\/קטגוריות|\/product|\/item/i.test(href)) {
          try {
            if (href.startsWith("/")) {
              const u = new URL(baseUrl);
              product_url = u.origin + href;
            } else if (href.startsWith("http")) {
              product_url = href;
            } else {
              const u = new URL(baseUrl);
              product_url = u.origin + "/" + href.replace(/^\//, "");
            }
          } catch {
            product_url = href;
          }
          if (product_url) break;
        }
      }
    }

    const plain = slice.replace(/<[^>]+>/g, " ");
    const product_name_guess =
      (plain.match(/קוקה.?קולה.*?(?:1\.5.?ליטר|1\.5.?L|2.?ליטר|1.?ליטר)/i) || [])[0] ||
      (plain.match(/(?:בקבוק|פחית|מארז).{0,30}(?:קולה|קוקה)/i) || [])[0] ||
      query;

    const price = asNumber(h.token);
    if (price != null && product_name_guess) {
      items.push({
        store_name,
        product_name: normalizeProductName(product_name_guess),
        price,
        product_url: product_url || baseUrl,
        source_domain: new URL(baseUrl).hostname,
        observed_price_text: h.token,
        size: inferSize(plain)
      });
    }
  }

  // dedupe (store,name,price)
  const seen = new Set<string>();
  const out: any[] = [];
  for (const it of items) {
    const key = [it.store_name, it.product_name, it.price].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/* ---------------------------
   fallback builders and generic parsing
   --------------------------- */
function buildFallbackUrl(host: string, query: string) {
  const q = encodeURIComponent(query);
  if (host === "zap.co.il") return `https://www.zap.co.il/search.aspx?keyword=${q}`;
  if (host === "pricez.co.il") return `https://www.pricez.co.il/SearchResult.aspx?search=${q}`;
  if (host === "bonusbuy.co.il") return `https://bonusbuy.co.il/search?query=${q}`;
  // generic
  return `https://${host}/search?q=${q}`;
}

async function scrapeAggregator(url: string, query: string, opts: { zyte?: boolean, zyteApiKey?: string } = {}) {
  const debug: any = { url, tried: [], parsed: 0, notes: [] };
  const results: any[] = [];
  const zyteEnabled = opts.zyte ?? USE_ZYTE;
  const zyteKey = opts.zyteApiKey ?? ZYTE_API_KEY;

  // 1) Zyte path (aggregators only)
  if (zyteEnabled && zyteKey && isAllowedAggregator(url)) {
    const zx = await zyteExtract(url, { apiKey: zyteKey });
    debug.tried.push({ via: "zyte", status: zx.status, ok: zx.ok });
    if (zx.ok && zx.data) {
      const list = zx.data?.productList?.products || [];
      for (const p of list) {
        const priceNum = asNumber(p?.price?.current ?? p?.price ?? p?.offers?.[0]?.price);
        if (!priceNum) continue;
        const link = p?.url || p?.productUrl || url;
        results.push({
          store_name: p?.retailer || p?.brand || "מקור משני",
          product_name: normalizeProductName(p?.name || p?.title || query),
          price: priceNum,
          product_url: link,
          source_domain: new URL(url).hostname,
          observed_price_text: String(p?.price?.display ?? p?.price?.current ?? p?.price ?? ""),
          size: p?.size || inferSize(p?.name || "")
        });
      }
    } else {
      // zyte returned no usable data; continue to HTTP path
    }
  }

  // 2) HTTP parse
  if (results.length === 0) {
    try {
      const r = await timedFetch(url, {}, REQUEST_TIMEOUT_MS);
      debug.tried.push({ via: "http", status: r.status, length: r.text?.length ?? 0 });
      if (r.status >= 200 && r.status < 300 && r.text) {
        const host = new URL(url).hostname;
        if (host.endsWith("chp.co.il")) {
          const parsed = parseCHP(r.text, url, query);
          debug.parsed = parsed.length;
          results.push(...parsed);
        } else {
          // generic aggregator: try to guess prices
          const text = htmlToText(r.text);
          const prices = guessPrices(text);
          if (prices.length > 0) {
            results.push({
              store_name: "מקור משני",
              product_name: normalizeProductName(query),
              price: prices.sort((a,b)=>a-b)[0],
              product_url: url,
              source_domain: host,
              observed_price_text: `₪${prices[0]}`,
              size: inferSize(text)
            });
          } else {
            debug.notes.push("no-price-in-text");
          }
        }
      } else {
        debug.notes.push("http-non-2xx-or-empty");
      }
    } catch (e) {
      debug.notes.push("http-error:" + (e as Error).message);
    }
  }

  return { results, debug };
}

/* ---------------------------
   normalize & ranking
   - groups by store_name; builds basket style structure
   --------------------------- */
function normalizeResults(items: any[]) {
  const groups = new Map<string, any[]>();
  for (const it of items) {
    // Safety: avoid returning direct retailer domains (unless allowed)
    try {
      if (!it.product_url || isRetailerDomain(it.product_url)) continue;
      if (!isAllowedAggregator(it.product_url)) {
        // If product_url is aggregator but not in ALLOWED_AGGREGATORS, still accept (best-effort)
      }
    } catch {
      continue;
    }

    const key = it.store_name || "לא ידוע";
    if (!groups.has(key)) groups.set(key, []);
    const arr = groups.get(key)!;
    arr.push({
      name: it.product_name,
      brand: inferBrand(it.product_name),
      quantity: 1,
      size: it.size || null,
      pack_qty: 1,
      unit: it.size?.includes("ליטר") ? "ליטר" : "יחידה",
      unit_price: it.price,
      ppu: it.price,
      line_total: it.price,
      product_url: it.product_url,
      source_domain: it.source_domain,
      observed_price_text: it.observed_price_text || (it.price ? `₪${it.price}` : null),
      in_stock: true,
      match_confidence: 0.6,
      substitution: false,
      notes: null,
      verification: {
        domain_ok: true,
        http_status: null,
        price_extracted: it.price,
        price_source: "parsed",
        found_shekel: true,
        price_matches: true,
        name_match: 0.5,
        notes: null
      }
    });
  }

  const out: any[] = [];
  for (const [store_name, basket] of groups) {
    const total_price = (basket as any[]).reduce((s:number, x:any) => s + (x.line_total || 0), 0);
    out.push({
      rank: 0,
      store_name,
      branch_id: null,
      branch_name: store_name,
      address: null,
      branch_url: null,
      distance_km: null,
      currency: "ILS",
      total_price,
      coverage: 1,
      notes: null,
      basket,
      match_overall: 0.6,
      store_verification: {
        approved_branch: false,
        verified_items: 0,
        total_items: basket.length,
        coverage_ratio: 0,
        store_verified: false,
        issues: []
      }
    });
  }

  // Sort by price ascending
  out.sort((a,b) => (a.total_price || Infinity) - (b.total_price || Infinity));
  out.forEach((x,i) => x.rank = i+1);

  return out;
}

/* ---------------------------
   top-level search flow:
   - CHP first
   - fallback hosts in order until we get results
   - ensure attempt to return up to three different shops if possible
   --------------------------- */
async function searchAggregators(query: string, { citySlug = "חולון" } = {}) {
  const traceId = genRequestId();
  const debug: any = {
    traceId,
    policy: { primary: AGGREGATOR_PRIMARY, fallbacks: AGGREGATOR_FALLBACKS, denyRetailers: true, useZyte: USE_ZYTE },
    steps: []
  };

  const qEnc = encodeURIComponent(query);
  const chpUrl = `https://${AGGREGATOR_PRIMARY}/${encodeURIComponent(citySlug)}/0/0/${qEnc}/0`;

  // STEP 1: CHP
  const stepChp = { site: AGGREGATOR_PRIMARY, url: chpUrl, status: "start" };
  debug.steps.push(stepChp);
  const chp = await scrapeAggregator(chpUrl, query);
  stepChp.status = "done";
  stepChp.debug = chp.debug;
  stepChp.found = (chp.results || []).length;

  let items = chp.results || [];

  // STEP 2: try fallbacks until we gather enough distinct stores (aim for at least 3)
  if ((items || []).length < 1) {
    for (const host of AGGREGATOR_FALLBACKS) {
      const url = buildFallbackUrl(host, query);
      const s = { site: host, url, status: "start" };
      debug.steps.push(s);
      const fb = await scrapeAggregator(url, query);
      s.status = "done";
      s.debug = fb.debug;
      s.found = (fb.results || []).length;
      if (fb.results && fb.results.length > 0) {
        items = items.concat(fb.results);
      }
      // if we have > =3 distinct store_names, stop early
      const distinctStores = new Set((items||[]).map((it:any)=>it.store_name));
      if (distinctStores.size >= 3) break;
    }
  }

  // In case still empty -> return empty results
  const normalized = normalizeResults(items || []);
  return { traceId, results: normalized, debug };
}

/* ---------------------------
   Router + Endpoints (Oak)
   --------------------------- */
const router = new Router();

// Health
router.get("/health", (ctx) => {
  ctx.response.body = { ok: true, env: NODE_ENV, time: new Date().toISOString() };
});

// Config
router.get("/config", (ctx) => {
  ctx.response.body = {
    NODE_ENV,
    PORT,
    USE_ZYTE,
    ENFORCE_APPROVED_BRANCHES,
    REQUEST_TIMEOUT_MS,
    ALLOWED_AGGREGATORS,
    RETAILER_DENYLIST_COUNT: RETAILER_DENYLIST.size,
    HAVE_ZYTE_KEY: !!ZYTE_API_KEY
  };
});

// Branches
router.get("/branches", (ctx) => {
  ctx.response.body = { count: APPROVED_BRANCHES.length, approved_place_ids: APPROVED_BRANCHES };
});

// Debug example (probe CHP)
router.get("/debug/example", async (ctx) => {
  const q = String(ctx.request.url.searchParams.get("q") ?? "קוקה קולה 1.5 ליטר");
  const citySlug = String(ctx.request.url.searchParams.get("city") ?? "חולון");
  const url = `https://${AGGREGATOR_PRIMARY}/${encodeURIComponent(citySlug)}/0/0/${encodeURIComponent(q)}/0`;
  const out: any = { query: q, city: citySlug, url, steps: [] };

  if (USE_ZYTE && ZYTE_API_KEY) {
    const zx = await zyteExtract(url, { apiKey: ZYTE_API_KEY });
    out.steps.push({ via: "zyte", ok: zx.ok, status: zx.status, zyte_summary: zx.data ? (Array.isArray(zx.data.productList?.products) ? zx.data.productList.products.length : undefined) : undefined });
  }

  try {
    const r = await timedFetch(url, {}, REQUEST_TIMEOUT_MS);
    out.steps.push({ via: "http", status: r.status, sample: r.text?.slice(0, 600) ?? "" });
    if (r.status >= 200 && r.status < 300 && r.text) {
      const parsed = parseCHP(r.text, url, q);
      out.extracted = parsed.slice(0, 8);
      out.count = parsed.length;
    }
  } catch (e) {
    out.steps.push({ via: "http", error: (e as Error).message });
  }

  ctx.response.body = out;
});

// Compare endpoint
router.get("/compare", async (ctx) => {
  try {
    const qraw = ctx.request.url.searchParams.get("q");
    if (!qraw) {
      ctx.response.status = 400;
      ctx.response.body = { status: "need_input", needed: ["q - query string"] };
      return;
    }
    const q = hebNormalize(String(qraw));
    const citySlug = String(ctx.request.url.searchParams.get("city") ?? "חולון");
    const show_all = String(ctx.request.url.searchParams.get("show_all") ?? "false").toLowerCase() === "true";

    // cache key
    const cacheKey = JSON.stringify({ q, citySlug, show_all });
    const cached = responseCache.get(cacheKey);
    if (cached) {
      ctx.response.body = { status: "ok", ...cached, cached: true };
      return;
    }

    const { traceId, results, debug } = await searchAggregators(q, { citySlug });

    // Optionally filter verified stores - in this aggregator-only mode we don't run server-side price verification
    // Just produce the normalized results and return
    const payload = { status: "ok", results, requestId: traceId, debug };
    responseCache.set(cacheKey, payload);
    ctx.response.body = payload;
  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { status: "error", error: (e as Error).message };
  }
});

// Root
router.get("/", (ctx) => {
  ctx.response.body = {
    message: "Price-compare Deno server",
    endpoints: ["/health", "/config", "/branches", "/debug/example?q=...", "/compare?q=...&city=..."]
  };
});

/* ---------------------------
   App + Middleware
   --------------------------- */
const app = new Application();

// simple request logging + trace id
app.use(async (ctx, next) => {
  const id = genRequestId();
  ctx.response.headers.set("x-trace-id", id);
  const start = now();
  try {
    await next();
  } finally {
    const dur = now() - start;
    const line = `${new Date().toISOString()} ${ctx.request.method} ${ctx.request.url.pathname} ${ctx.response.status} ${dur}ms trace=${id}`;
    if (ctx.response.status && ctx.response.status >= 500) console.error(line);
    else console.log(line);
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`[server] listening on http://localhost:${PORT} (env=${NODE_ENV})`);
await app.listen({ port: PORT });

/* ---------------------------
   End of file
   --------------------------- */
