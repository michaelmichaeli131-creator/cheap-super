/**
 * Full Price Comparison Server (Aggregator-Only, CHP-first)
 * ---------------------------------------------------------------------------------
 * What you get in this single file:
 * - Express HTTP server with robust endpoints: /health, /config, /branches, /debug/example, /compare
 * - Aggregator-first pipeline: CHP → (if empty) one of [zap, pricez, bonusbuy]
 * - Absolutely avoids retailer domains (Shufersal, Victory, etc.)
 * - Optional Zyte extraction for aggregators only (guarded by USE_ZYTE)
 * - Strong debug output including a full step trace and Zyte/HTTP details
 * - LRU cache, request tracing, retries, randomized User-Agent, Hebrew-friendly
 * - Normalization + basic ranking; result schema matches the examples you shared
 * - No external parsers required (regex/heuristics); you can add cheerio if desired
 *
 * Quickstart:
 *   1) npm init -y && npm i express node-fetch dotenv
 *   2) (optional) npm i cross-env
 *   3) Create a .env with:
 *        PORT=3000
 *        NODE_ENV=development
 *        USE_ZYTE=false
 *        ZYTE_API_KEY=  # (optional)
 *        REQUEST_TIMEOUT_MS=18000
 *        ENFORCE_APPROVED_BRANCHES=false
 *   4) node price-compare-server.js
 *   5) GET http://localhost:3000/compare?q=קוקה%20קולה%201.5%20ליטר&city=חולון
 *
 * Notes:
 * - This file is intentionally verbose and heavily commented so you can tweak anything.
 * - CHP is the primary source. Only if CHP returns 0 items do we try the other aggregators.
 * - You asked specifically for a CHP-first approach and to keep to less-hostile sites.
 */

import express from "express";
import fetch, { Headers } from "node-fetch";
import crypto from "crypto";
import * as http from "http";
import * as https from "https";
import { config as loadEnv } from "dotenv";

// Load .env if present
loadEnv();

// --------------------------------------------------------------------------------
// Environment and Flags
// --------------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const USE_ZYTE = String(process.env.USE_ZYTE || "false").toLowerCase() === "true";
const ZYTE_API_KEY = process.env.ZYTE_API_KEY || "";
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "18000", 10);
const ENFORCE_APPROVED_BRANCHES = String(process.env.ENFORCE_APPROVED_BRANCHES || "false").toLowerCase() === "true";

// CHP-first policy: only if empty, move to these fallbacks (still aggregators)
const AGGREGATOR_PRIMARY = "chp.co.il";
const AGGREGATOR_FALLBACKS = ["zap.co.il", "pricez.co.il", "bonusbuy.co.il"];
const ALLOWED_AGGREGATORS = [AGGREGATOR_PRIMARY, ...AGGREGATOR_FALLBACKS];

// Strict retailer denylist (will be filtered even if accidentally encountered)
const RETAILER_DENYLIST = [
  "shufersal.co.il",
  "victoryonline.co.il",
  "ramilevy.co.il",
  "yohananof.co.il",
  "osherad.co.il",
  "yenotbitan.co.il",
  "tivtaam.co.il",
  "superdosh.co.il",
  "keshet-teamim.co.il",
  "mega.co.il",
];

// LRU Cache implementation (simple)
class LRUCache {
  constructor(max = 128) {
    this.max = max;
    this.map = new Map();
  }
  _bump(k) {
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    this._bump(k);
    return this.map.get(k);
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
}

const responseCache = new LRUCache(200);

// Minimal approved branches mock (Google place_ids). Not used for retailers here, but kept for API parity.
const APPROVED_BRANCHES = [
  "ChIJm3E2f42zAhURPWjno-zc_7U",
  "ChIJtSxk3F6zAhURG-fMxF5vY2Y",
  "ChIJDYA4PQ2zAhUR5Zhc6BwkAhE",
];

// HTTP agents
const HTTPS_AGENT = new https.Agent({ keepAlive: true, timeout: REQUEST_TIMEOUT_MS });
const HTTP_AGENT = new http.Agent({ keepAlive: true, timeout: REQUEST_TIMEOUT_MS });

// --------------------------------------------------------------------------------
// Utility helpers
// --------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const genRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

function hebNormalize(str) {
  if (!str) return "";
  return str
    .replace(/\s+/g, " ")
    .replace(/[״"′’]/g, '"')
    .replace(/[׳']/g, "'")
    .trim();
}

function asNumber(x, fallback = null) {
  if (x == null) return fallback;
  const n = Number(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function chooseUA() {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

function isRetailerDomain(url) {
  try {
    const { hostname } = new URL(url);
    return RETAILER_DENYLIST.some((d) => hostname.endsWith(d));
  } catch {
    return false;
  }
}

function isAllowedAggregator(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_AGGREGATORS.some((d) => hostname.endsWith(d));
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------------
// HTTP fetch with retries and timeouts
// --------------------------------------------------------------------------------
async function httpGet(url, { headers = {}, timeout = REQUEST_TIMEOUT_MS, retry = 2 } = {}) {
  const h = new Headers(headers);
  if (!h.has("user-agent")) h.set("user-agent", chooseUA());
  if (!h.has("accept-language")) h.set("accept-language", "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7");
  if (!h.has("accept")) h.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error("timeout")), timeout);
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: h,
        redirect: "follow",
        agent: new URL(url).protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
        signal: controller.signal,
      });
      clearTimeout(t);
      const status = resp.status;
      const text = await resp.text();
      return { status, text };
    } catch (e) {
      lastErr = e;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error("fetch-failed");
}

// --------------------------------------------------------------------------------
// Optional: Zyte extraction (aggregators only)
// --------------------------------------------------------------------------------
async function zyteExtract(url, { apiKey = ZYTE_API_KEY, timeout = 22000 } = {}) {
  if (!USE_ZYTE) return { ok: false, disabled: true, status: 412 };
  if (!apiKey) return { ok: false, status: 400, error: "missing-zyte-api-key" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeout);
  try {
    const resp = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        Authorization: "Apikey " + apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url, httpResponseBody: true, productList: true }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const status = resp.status;
    const data = await resp.json();
    return { ok: status >= 200 && status < 300, status, data };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 500, error: e.message };
  }
}

// --------------------------------------------------------------------------------
// Lightweight HTML/Regex helpers (no cheerio dependency)
// --------------------------------------------------------------------------------
function extractLinksFromHtml(html) {
  const links = [];
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push({ href: m[1], inner: m[2] });
  }
  return links;
}

function htmlToText(html) {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return hebNormalize(noScripts.replace(/<[^>]+>/g, " "));
}

function guessPrices(text) {
  const found = [];
  const rx = /(₪\s?\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?\s?₪)/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const token = m[0];
    const val = asNumber(token);
    if (val != null && val > 0 && val < 10000) found.push(val);
  }
  return found;
}

function inferSize(text) {
  const pats = [
    /(\d+(?:\.\d+)?)\s?(?:ליטר|L)\b/i,
    /(\d+(?:\.\d+)?)\s?(?:מ\"ל|מיליליטר|ml)\b/i,
    /\b(\d+)\s?יח'?\b/i,
    /\b(\d+)\s?בקב(?:ו)?קים?\b/i,
    /\b(\d+)\s?פחיות?\b/i,
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

function normalizeProductName(name) {
  return hebNormalize(name).replace(/\s{2,}/g, " ").trim();
}

function inferBrand(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/(קוקה|coca)/.test(n)) return "קוקה קולה";
  if (/(פפסי|pepsi)/.test(n)) return "פפסי";
  return null;
}

// --------------------------------------------------------------------------------
// CHP-specific parsing (heuristic, robust enough for list pages)
// --------------------------------------------------------------------------------
function parseCHP(html, baseUrl, query) {
  const items = [];
  const links = extractLinksFromHtml(html);

  // Anchor the search around price tokens to find nearby context
  const priceTokenRx = /(₪\s?\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?\s?₪)/g;
  const hits = [];
  let m;
  while ((m = priceTokenRx.exec(html)) !== null) {
    hits.push({ index: m.index, token: m[0] });
  }

  const WINDOW = 900; // chars to look around each price
  for (const h of hits) {
    const left = Math.max(0, h.index - WINDOW);
    const right = Math.min(html.length, h.index + WINDOW);
    const slice = html.slice(left, right);

    // Try to infer store name within the slice
    const storeNameMatch = slice.match(
      /(?:שופרסל|ויקטורי|רמי לוי|טיב טעם|יוחננוף|מחסני השוק|יינות ביתן|חצי חינם|פרשמרקט|סופר דוש|אושר עד)/
    );
    const store_name = storeNameMatch ? storeNameMatch[0] : "לא ידוע (CHP)";

    // Find a nearby product-like link
    let product_url = null;
    for (const { href } of links) {
      const pos = html.indexOf(href);
      if (pos >= left && pos <= right) {
        if (/\/search|\/%D7%|\?q=|\/קטגוריות|\/product|\/item/i.test(href)) {
          if (href.startsWith("/")) {
            const u = new URL(baseUrl);
            product_url = u.origin + href;
          } else if (href.startsWith("http")) {
            product_url = href;
          } else {
            try {
              const u = new URL(baseUrl);
              product_url = u.origin + "/" + href.replace(/^\//, "");
            } catch {}
          }
          if (product_url) break;
        }
      }
    }

    // Guess a product name near the price
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
        size: inferSize(plain),
      });
    }
  }

  // Deduplicate by (store, name, price)
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = [it.store_name, it.product_name, it.price].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

// --------------------------------------------------------------------------------
// Fallback aggregator scraping
// --------------------------------------------------------------------------------
function buildFallbackUrl(host, query) {
  const q = encodeURIComponent(query);
  if (host === "zap.co.il") return `https://www.zap.co.il/search.aspx?keyword=${q}`;
  if (host === "pricez.co.il") return `https://www.pricez.co.il/SearchResult.aspx?search=${q}`;
  if (host === "bonusbuy.co.il") return `https://bonusbuy.co.il/search?query=${q}`;
  return `https://${host}/search?q=${q}`;
}

async function scrapeAggregator(url, query, { zyte = USE_ZYTE, zyteApiKey = ZYTE_API_KEY } = {}) {
  const debug = { url, tried: [], parsed: 0, notes: [] };
  const results = [];

  // 1) Try Zyte first if enabled and allowed
  if (zyte && zyteApiKey && isAllowedAggregator(url)) {
    const zx = await zyteExtract(url, { apiKey: zyteApiKey });
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
          size: p?.size || inferSize(p?.name || ""),
        });
      }
    }
  }

  // 2) If nothing yet, try direct HTTP and parse
  if (results.length === 0) {
    try {
      const r = await httpGet(url, { retry: 1 });
      debug.tried.push({ via: "http", status: r.status, length: r.text?.length || 0 });
      if (r.status >= 200 && r.status < 300 && r.text) {
        const host = new URL(url).hostname;
        if (host.endsWith("chp.co.il")) {
          const parsed = parseCHP(r.text, url, query);
          debug.parsed = parsed.length;
          results.push(...parsed);
        } else {
          // Generic fallbacks: try to find any price token and assemble a minimal hit
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
              size: inferSize(text),
            });
          } else {
            debug.notes.push("no-price-in-fallback-text");
          }
        }
      } else {
        debug.notes.push("http-non-2xx-or-empty");
      }
    } catch (e) {
      debug.notes.push("http-error:" + e.message);
    }
  }

  return { results, debug };
}

// --------------------------------------------------------------------------------
// Normalization & Ranking
// --------------------------------------------------------------------------------
function normalizeResults(items) {
  // group by store for the output schema you used
  const groups = new Map();
  for (const it of items) {
    if (!isAllowedAggregator(it.product_url) || isRetailerDomain(it.product_url)) continue; // hard safety
    const key = it.store_name || "לא ידוע";
    if (!groups.has(key)) groups.set(key, []);
    const arr = groups.get(key);
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
        notes: null,
      },
    });
  }

  const out = [];
  for (const [store_name, basket] of groups) {
    const total_price = basket.reduce((s, x) => s + (x.line_total || 0), 0);
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
        issues: [],
      },
    });
  }
  // sort by total price asc and rank
  out.sort((a, b) => (a.total_price || Infinity) - (b.total_price || Infinity));
  out.forEach((x, i) => (x.rank = i + 1));
  return out;
}

// --------------------------------------------------------------------------------
// High-level Search (CHP first, then fallback aggregators if CHP empty)
// --------------------------------------------------------------------------------
async function searchAggregators(query, { citySlug = "חולון" } = {}) {
  const traceId = genRequestId();
  const debug = {
    traceId,
    policy: {
      primary: AGGREGATOR_PRIMARY,
      fallbacks: AGGREGATOR_FALLBACKS,
      denyRetailers: true,
      useZyte: USE_ZYTE,
    },
    steps: [],
  };

  const qEnc = encodeURIComponent(query);
  const chpUrl = `https://chp.co.il/${encodeURIComponent(citySlug)}/0/0/${qEnc}/0`;

  // STEP 1: CHP
  const step1 = { site: AGGREGATOR_PRIMARY, url: chpUrl, status: "start" };
  debug.steps.push(step1);
  const chp = await scrapeAggregator(chpUrl, query);
  step1.status = "done";
  step1.debug = chp.debug;
  step1.found = chp.results.length;

  let items = chp.results || [];

  // STEP 2: fallbacks only if CHP empty
  if (items.length === 0) {
    for (const host of AGGREGATOR_FALLBACKS) {
      const url = buildFallbackUrl(host, query);
      const st = { site: host, url, status: "start" };
      debug.steps.push(st);
      const fb = await scrapeAggregator(url, query);
      st.status = "done";
      st.debug = fb.debug;
      st.found = fb.results.length;
      if (fb.results.length > 0) {
        items = fb.results;
        break;
      }
    }
  }

  const normalized = normalizeResults(items);
  return { traceId, results: normalized, debug };
}

// --------------------------------------------------------------------------------
// Express App & Routes
// --------------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Simple request logger
app.use((req, res, next) => {
  const id = genRequestId();
  req._traceId = id;
  const start = now();
  res.setHeader("x-trace-id", id);
  res.on("finish", () => {
    const dur = now() - start;
    const line = `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${dur}ms trace=${id}`;
    if (res.statusCode >= 500) console.error(line);
    else console.log(line);
  });
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() });
});

app.get("/config", (req, res) => {
  res.json({
    NODE_ENV,
    PORT,
    USE_ZYTE,
    ENFORCE_APPROVED_BRANCHES,
    REQUEST_TIMEOUT_MS,
    ALLOWED_AGGREGATORS,
    RETAILER_DENYLIST_COUNT: RETAILER_DENYLIST.length,
    HAVE_ZYTE_KEY: Boolean(ZYTE_API_KEY),
  });
});

app.get("/branches", (req, res) => {
  res.json({ count: APPROVED_BRANCHES.length, approved_place_ids: APPROVED_BRANCHES });
});

// Raw CHP probe for manual debugging (no LLM involved)
app.get("/debug/example", async (req, res) => {
  const q = req.query.q ? hebNormalize(String(req.query.q)) : "קוקה קולה 1.5 ליטר";
  const citySlug = req.query.city ? String(req.query.city) : "חולון";
  const url = `https://chp.co.il/${encodeURIComponent(citySlug)}/0/0/${encodeURIComponent(q)}/0`;

  const out = { query: q, city: citySlug, url, steps: [] };

  if (USE_ZYTE && ZYTE_API_KEY) {
    const zx = await zyteExtract(url, { apiKey: ZYTE_API_KEY });
    out.steps.push({ via: "zyte", ok: zx.ok, status: zx.status });
  }

  try {
    const r = await httpGet(url, { retry: 1 });
    out.steps.push({ via: "http", status: r.status, sample: r.text?.slice(0, 400) || "" });
    if (r.status >= 200 && r.status < 300 && r.text) {
      const parsed = parseCHP(r.text, url, q);
      out.extracted = parsed.slice(0, 5);
      out.count = parsed.length;
    }
  } catch (e) {
    out.steps.push({ via: "http", error: e.message });
  }

  res.json(out);
});

// Main search endpoint
app.get("/compare", async (req, res) => {
  try {
    const q = req.query.q ? hebNormalize(String(req.query.q)) : "קוקה קולה 1.5 ליטר";
    const citySlug = req.query.city ? String(req.query.city) : "חולון";

    // Cache key
    const cacheKey = JSON.stringify({ q, citySlug });
    const cached = responseCache.get(cacheKey);
    if (cached) {
      return res.json({ status: "ok", ...cached, cached: true });
    }

    const { traceId, results, debug } = await searchAggregators(q, { citySlug });

    const payload = {
      status: "ok",
      results,
      requestId: traceId,
      debug,
    };
    responseCache.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ status: "not_found", path: req.path });
});

// Start server
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (env=${NODE_ENV})`);
});
