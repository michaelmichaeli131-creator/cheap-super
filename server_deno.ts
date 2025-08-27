// server_deno.ts
// Deno + Hono + OpenAI Responses API (web_search) + Google Places + Zyte Auto-Extraction
// מצב: משתמשים ב-Zyte לכל פריט (ברירת מחדל), עם קאשינג ו-timeouts.
// שים לב: צריך ZYTE_API_KEY בצד שרת.

// (אופציונלי) טען .env מקומית
import "jsr:@std/dotenv/load";

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1";
const PLACES_KEY   = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
const DEBUG        = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";
const TEMP_STR     = Deno.env.get("OPENAI_TEMPERATURE");
const OPENAI_TEMP  = (TEMP_STR!=null && TEMP_STR.trim()!=="") ? Number(TEMP_STR) : 0;

// Timeouts/Retry
const PLACES_TIMEOUT_MS        = Number(Deno.env.get("PLACES_TIMEOUT_MS") || 25000);
const PRODUCT_FETCH_TIMEOUT_MS = Number(Deno.env.get("PRODUCT_FETCH_TIMEOUT_MS") || 30000);
const OPENAI_TIMEOUT_MS        = Number(Deno.env.get("OPENAI_TIMEOUT_MS") || 60000);
const RETRY_ATTEMPTS           = Math.max(1, Number(Deno.env.get("RETRY_ATTEMPTS") || 3));
const RETRY_BASE_MS            = Math.max(200, Number(Deno.env.get("RETRY_BASE_MS") || 600));

// Allowed domains mode: both (retailers + aggregators) כברירת מחדל
const ALLOWED_MODE = (Deno.env.get("ALLOWED_DOMAINS_MODE") || "both").toLowerCase(); // "aggregators" | "retailers" | "both"
const RETAILER_DOMAINS = [
  "shufersal.co.il","rami-levy.co.il","victoryonline.co.il",
  "yohananof.co.il","tivtaam.co.il","osherad.co.il"
];
const AGGREGATOR_DOMAINS_DEFAULT = [
  "zap.co.il","pricez.co.il","bonusbuy.co.il"
];
const AGGREGATOR_DOMAINS = (Deno.env.get("ALLOWED_DOMAINS_CSV") || "")
  .split(",").map(s=>s.trim()).filter(Boolean);
if (AGGREGATOR_DOMAINS.length===0) AGGREGATOR_DOMAINS.push(...AGGREGATOR_DOMAINS_DEFAULT);

const ALLOWED_DOMAINS = new Set(
  ALLOWED_MODE === "retailers" ? RETAILER_DOMAINS
  : ALLOWED_MODE === "aggregators" ? AGGREGATOR_DOMAINS
  : [...RETAILER_DOMAINS, ...AGGREGATOR_DOMAINS] // both
);

// Zyte Auto-Extraction
const ZYTE_API_KEY = Deno.env.get("ZYTE_API_KEY") || "";
const AUTO_EXTRACT_MODE = (Deno.env.get("AUTO_EXTRACT_MODE") || "on").toLowerCase() === "on"; // ברירת מחדל: ON
const AUTO_EXTRACT_TTL_MS = Number(Deno.env.get("AUTO_EXTRACT_TTL_MS") || 120000);
const AUTO_EXTRACT_MAX_CONCURRENCY = Math.max(1, Number(Deno.env.get("AUTO_EXTRACT_MAX_CONCURRENCY") || 4));

// אימות חנות: כמה שורות צריכות לעבור
const COVERAGE_THRESHOLD = 0.6;

// ===== Utils =====
const SAFE_DEBUG_MAX = 2500;
const UA = "CartCompareAI/1.0 (Deno; zyte-all; timeouts+retries)";

function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }
class HttpError extends Error { status:number; payload?:unknown; constructor(s:number,m:string,p?:unknown){ super(m); this.status=s; this.payload=p; } }

function extractJson(text:string){
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a>=0 && b>a) { try { return JSON.parse(text.slice(a, b+1)); } catch {} }
  return null;
}
function decodeHtmlEntities(s: string): string {
  if (!s) return "";
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_,h)=> String.fromCharCode(parseInt(h,16)));
  s = s.replace(/&#(\d+);/g, (_,d)=> String.fromCharCode(parseInt(d,10)));
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function stripBidiControls(s: string): string {
  if (!s) return "";
  const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  return s.replace(BIDI, "");
}
function normalizeSpaces(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function cleanText(s: string, maxLen = 400){ const out = normalizeSpaces(stripBidiControls(decodeHtmlEntities(s))); return out.length>maxLen? out.slice(0,maxLen-1)+"…" : out; }
function haversineKm(a:{lat:number,lng:number}, b:{lat:number,lng:number}){
  const R=6371; const dLat=(b.lat-a.lat)*Math.PI/180; const dLng=(b.lng-a.lng)*Math.PI/180;
  const s=Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function parseNumberLocaleish(x:string){
  return Number(
    x.replace(/\u200f|\u200e/g, "")
     .replace(/\s/g,"")
     .replace(/(?<=\d)[,](?=\d{3}\b)/g,"")
     .replace(/[.](?=\d{3}\b)/g,"")
     .replace(/,/g,".")
  );
}
function approxEq(a:number,b:number,pct=0.05){ const d=Math.abs(a-b); return d<=Math.max(1,b*pct); }

// ===== Allowed domains & host check =====
function hostOK(urlStr:string){
  try {
    const u = new URL(urlStr);
    return ALLOWED_DOMAINS.has(u.hostname.replace(/^www\./,""));
  } catch { return false; }
}

// ===== HTTP helpers (timeouts + retries) =====
async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms: number){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort(`timeout ${ms}ms`), ms);
  try{ return await fetch(input, { ...init, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}
async function retry<T>(fn:()=>Promise<T>, attempts=RETRY_ATTEMPTS, baseMs=RETRY_BASE_MS): Promise<T>{
  let last:any;
  for (let i=0;i<attempts;i++){
    try{ return await fn(); }
    catch(e){ last=e; const wait=baseMs*Math.pow(2,i)+Math.floor(Math.random()*100); await new Promise(r=>setTimeout(r,wait)); }
  }
  throw last;
}

// ===== Google Geocode + Places =====
async function geocodeAddress(id:string, address:string){
  if (!PLACES_KEY) throw new HttpError(500, "Missing GOOGLE_PLACES_API_KEY");
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", address);
  u.searchParams.set("key", PLACES_KEY);
  const r = await retry(()=> fetchWithTimeout(u, {
    headers: {
      "user-agent": UA,
      "accept": "application/json",
      "accept-language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache"
    }
  }, PLACES_TIMEOUT_MS));
  const j = await r.json();
  if (j.status!=="OK" || !j.results?.[0]?.geometry?.location) throw new HttpError(400, "Geocode failed for address");
  const { lat, lng } = j.results[0].geometry.location;
  return { lat, lng, formatted: j.results[0].formatted_address as string };
}
async function nearbyForChain(id:string, center:{lat:number;lng:number}, radiusMeters:number, chainKeyword:string){
  const u = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
  u.searchParams.set("key", PLACES_KEY);
  u.searchParams.set("location", `${center.lat},${center.lng}`);
  u.searchParams.set("radius", String(Math.min(radiusMeters, 50000)));
  u.searchParams.set("keyword", chainKeyword);
  u.searchParams.set("type", "supermarket");
  const r = await retry(()=> fetchWithTimeout(u, {
    headers: {
      "user-agent": UA,
      "accept": "application/json",
      "accept-language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache"
    }
  }, PLACES_TIMEOUT_MS));
  const j = await r.json();
  if (j.status!=="OK" && j.status!=="ZERO_RESULTS"){ info(id, "Places nearby status", j.status); }
  const items = Array.isArray(j.results) ? j.results : [];
  return items.map((p:any)=>({
    place_id: String(p.place_id||""),
    name: String(p.name||""),
    address: String(p.vicinity || p.formatted_address || ""),
    lat: Number(p.geometry?.location?.lat ?? 0),
    lng: Number(p.geometry?.location?.lng ?? 0),
    maps_url: p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : "",
    rating: typeof p.rating==="number" ? p.rating : null
  }));
}

type Branch = {
  branch_id: string;
  chain: string;
  branch_name: string;
  address: string;
  lat: number;
  lng: number;
  branch_url: string;
  distance_km: number;
};
const APPROVED_CHAINS = [
  { chain: "שופרסל",   keyword: "שופרסל סניף" },
  { chain: "רמי לוי",  keyword: "רמי לוי סניף" },
  { chain: "ויקטורי",  keyword: "ויקטורי סניף" },
  { chain: "טיב טעם",  keyword: "טיב טעם סניף" },
  { chain: "יוחננוף",  keyword: "יוחננוף סניף" },
  { chain: "אושר עד",  keyword: "אושר עד סניף" },
];

async function listApprovedBranches(id:string, address:string, radius_km:number){
  const geo = await geocodeAddress(id, address);
  const center = { lat: geo.lat, lng: geo.lng };
  const radiusMeters = Math.max(500, Math.round(radius_km*1000));
  const out: Branch[] = [];
  for (const c of APPROVED_CHAINS){
    const raw = await nearbyForChain(id, center, radiusMeters, c.keyword + " " + address);
    const mapped = raw.map(p=>{
      const d = p.lat && p.lng ? haversineKm(center, {lat:p.lat,lng:p.lng}) : 9999;
      const name = p.name || c.chain;
      return <Branch>{
        branch_id: p.place_id,
        chain: c.chain,
        branch_name: name,
        address: p.address || "",
        lat: p.lat, lng: p.lng,
        branch_url: p.maps_url,
        distance_km: Math.round(d*10)/10
      };
    })
    .filter(b => b.branch_id && b.distance_km <= radius_km + 0.8)
    .sort((a,b)=> a.distance_km - b.distance_km)
    .slice(0, 3);
    out.push(...mapped);
  }
  out.sort((a,b)=> a.distance_km - b.distance_km);
  return { center, formatted_address: geo.formatted, branches: out.slice(0, 12) };
}

// ===== Prompt (אין עוד דרישת ₪ — השרת ישתמש ב-Zyte) =====
const PROMPT_SYSTEM = `
You are a price-comparison agent for Israeli groceries.

HARD POLICY (DO NOT VIOLATE):
- Do NOT fabricate prices or branches. Use ONLY information found now on the public web.
- Branches MUST be selected ONLY from APPROVED_BRANCHES JSON (branch_id required). If none match—return empty results.
- Product links (product_url) MUST be from the provided ALLOWED_DOMAINS list.
- If an exact pack/size is unavailable, return a close substitute and set substitution=true; compute ppu (price per unit) and explain in notes.
- Never output free text; finish by calling submit_results once.

TOOLS:
- web_search: issue focused bilingual queries with brand + size + pack, restricted to ALLOWED_DOMAINS (e.g., site:shufersal.co.il or site:zap.co.il).
`.trim();

// ===== submit_results schema =====
const SUBMIT_RESULTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status","results"],
  properties: {
    status: { type:"string", enum:["ok"] },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rank","store_name","branch_id","branch_name","address","branch_url",
          "distance_km","currency","total_price","coverage","notes",
          "basket","match_overall"
        ],
        properties: {
          rank: { type:"integer" },
          store_name: { type:"string" },
          branch_id: { type:"string" },
          branch_name: { type:"string" },
          address: { type:"string" },
          branch_url: { type:"string" },
          distance_km: { type:"number" },
          currency: { type:"string" },
          total_price: { type:"number" },
          coverage: { type:"number", minimum:0, maximum:1 },
          notes: { type:["string","null"] },
          basket: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "name","brand","quantity","size","pack_qty","unit",
                "unit_price","ppu","line_total",
                "product_url","source_domain","source_title",
                "observed_price_text","observed_at","in_stock",
                "match_confidence","substitution","notes"
              ],
              properties: {
                name: { type:"string" },
                brand: { type:["string","null"] },
                quantity: { type:"number" },
                size: { type:["string","null"] },
                pack_qty: { type:["number","null"] },
                unit: { type:["string","null"] },
                unit_price: { type:"number" },
                ppu: { type:["number","null"] },
                line_total: { type:"number" },
                product_url: { type:"string" },
                source_domain: { type:"string" },
                source_title: { type:["string","null"] },
                observed_price_text: { type:["string","null"] },
                observed_at: { type:["string","null"] },
                in_stock: { type:"boolean" },
                match_confidence: { type:"number", minimum:0, maximum:1 },
                substitution: { type:"boolean" },
                notes: { type:["string","null"] }
              }
            }
          },
          match_overall: { type:"number", minimum:0, maximum:1 }
        }
      }
    }
  }
} as const;

// ===== OpenAI Responses API (with timeout) =====
async function callOpenAIOnce(systemPrompt: string, userPrompt: string, id: string){
  if (!OPENAI_KEY) throw new HttpError(500, "Missing OPENAI_API_KEY");

  const body: any = {
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: userPrompt,
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "submit_results",
        description: "Return final structured comparison results. MUST be called exactly once at the end.",
        parameters: SUBMIT_RESULTS_SCHEMA
      }
    ],
    tool_choice: "auto",
    temperature: isFinite(OPENAI_TEMP) ? OPENAI_TEMP : 0,
    max_output_tokens: 2200
  };

  const resp = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_KEY}`,
      "content-type": "application/json",
      "user-agent": UA
    },
    body: JSON.stringify(body)
  }, OPENAI_TIMEOUT_MS).catch((e)=> {
    throw new HttpError(502, `OpenAI fetch error: ${e?.message || String(e)}`);
  });

  const requestIdHeader = resp.headers.get("x-request-id") || resp.headers.get("openai-request-id") || null;

  let jsonOrText: any = null;
  try { jsonOrText = await resp.json(); }
  catch { try { jsonOrText = await resp.text(); } catch { jsonOrText = null; } }

  if (!resp.ok) {
    throw new HttpError(resp.status, `OpenAI ${resp.status}`, {
      error: (jsonOrText?.error ?? jsonOrText ?? null),
      full_response: jsonOrText ?? null,
      x_request_id: requestIdHeader
    });
  }

  const outputArr = Array.isArray(jsonOrText?.output) ? jsonOrText.output : [];
  const fnCall = outputArr.find((p:any)=> p?.type==="function_call" && p?.name==="submit_results");
  if (!fnCall) {
    const text =
      (typeof jsonOrText?.output_text === "string" && jsonOrText.output_text) ||
      (Array.isArray(outputArr) ? outputArr.map((p:any)=> (typeof p?.content === "string" ? p.content : "")).join("\n") : "") ||
      "";
    const tryParsed = extractJson(text);
    if (tryParsed) return { parsed: tryParsed, raw: jsonOrText, request_id: requestIdHeader };
    throw new HttpError(400, "Model did not return a submit_results tool call", {
      output_text_excerpt: text ? text.slice(0, SAFE_DEBUG_MAX) : "",
      raw_excerpt: JSON.stringify(jsonOrText ?? "").slice(0, SAFE_DEBUG_MAX),
      x_request_id: requestIdHeader
    });
  }

  let parsed:any = null;
  try { parsed = typeof fnCall.arguments === "string" ? JSON.parse(fnCall.arguments) : fnCall.arguments; }
  catch {
    throw new HttpError(400, "Failed to parse submit_results.arguments", {
      arguments_excerpt: String(fnCall?.arguments ?? "").slice(0, SAFE_DEBUG_MAX),
      x_request_id: requestIdHeader
    });
  }

  return { parsed, raw: jsonOrText, request_id: requestIdHeader };
}

// ===== Zyte Adapter + Cache =====
type ZyteProduct = {
  name?: string;
  brand?: string;
  offers?: Array<{ price?: number; priceCurrency?: string; availability?: string; url?: string }>;
  gtin?: string;
  sku?: string;
};

const zyteCache = new Map<string, { ts: number; data: ZyteProduct | null }>();
function zyteCacheGet(key: string) {
  const hit = zyteCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > AUTO_EXTRACT_TTL_MS) { zyteCache.delete(key); return null; }
  return hit.data;
}
function zyteCacheSet(key: string, data: ZyteProduct | null) {
  zyteCache.set(key, { ts: Date.now(), data });
}

let zyteInFlight = 0;
const zyteQueue: Array<() => void> = [];
async function zyteGate<T>(fn:()=>Promise<T>): Promise<T> {
  if (zyteInFlight >= AUTO_EXTRACT_MAX_CONCURRENCY) {
    await new Promise<void>(resolve => zyteQueue.push(resolve));
  }
  zyteInFlight++;
  try { return await fn(); }
  finally {
    zyteInFlight--;
    const next = zyteQueue.shift();
    if (next) next();
  }
}

async function extractProductWithZyte(url: string): Promise<ZyteProduct | null> {
  if (!ZYTE_API_KEY) throw new HttpError(500, "Missing ZYTE_API_KEY");
  const cacheKey = `zyte:${url}`;
  const cached = zyteCacheGet(cacheKey);
  if (cached) return cached;

  const doCall = async () => {
    const r = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${ZYTE_API_KEY}`,
        "content-type": "application/json",
        "user-agent": UA,
      },
      body: JSON.stringify({
        url,
        productOptions: { extractFrom: "browser" }
      }),
    }).catch(e => { throw new HttpError(502, `Zyte fetch error: ${e?.message || String(e)}`); });

    if (!r.ok) {
      const txt = await r.text().catch(()=> "");
      zyteCacheSet(cacheKey, null);
      throw new HttpError(r.status, `Zyte ${r.status}`, { body_excerpt: txt.slice(0, 1000) });
    }
    const j = await r.json().catch(()=> ({}));
    return j?.product ?? null;
  };

  const product = await zyteGate(() => doCall());
  zyteCacheSet(cacheKey, product);
  return product;
}

function normalizeZyteToLine(base: any, url: string, zp: ZyteProduct | null) {
  const offer = zp?.offers?.[0] || {};
  const price = typeof offer.price === "number" ? offer.price : null;
  const currency = (offer.priceCurrency || "").toUpperCase() || "ILS";
  const inStock = String(offer.availability || "").toLowerCase().includes("instock");
  return {
    name: zp?.name || base?.name || "",
    brand: zp?.brand || base?.brand || null,
    unit_price: price ?? base?.unit_price ?? null,
    currency,
    in_stock: inStock,
    product_url: offer.url || url,
    observed_price_text: (price!=null ? `${price}` : null),
    price_source: "zyte" as const
  };
}

// ===== (Optional) HTML fetch helpers – נשארו לגיבוי אם תרצה בעתיד =====
async function fetchText(url:string){
  const res = await retry(()=> fetchWithTimeout(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
      "cache-control": "no-cache"
    }
  }, PRODUCT_FETCH_TIMEOUT_MS));
  const txt = await res.text().catch(()=> "");
  return { status: res.status, text: txt.slice(0, 300_000) };
}
function extractPriceFromHtml(htmlRaw:string){
  const html = decodeHtmlEntities(htmlRaw||"");
  // ₪
  const re = /₪\s*([\d.,]+)|([\d.,]+)\s*₪/g;
  for (let m; (m = re.exec(html)); ){
    const s = (m[1] || m[2] || "").trim();
    const v = parseNumberLocaleish(s);
    if (!Number.isNaN(v)) return { value: v, source: "shekel-sign" as const };
  }
  // JSON-LD
  const ldBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldBlocks){
    try{
      const jsonText = block.replace(/^<script[^>]*>/i,"").replace(/<\/script>$/i,"");
      const json = JSON.parse(jsonText);
      const candidates:any[] = [];
      const crawl = (x:any)=>{ if(!x||typeof x!=="object") return; if (x.price||x.priceCurrency||x["@type"]==="Offer"||x["@type"]==="AggregateOffer") candidates.push(x); if(Array.isArray(x)) x.forEach(crawl); else Object.values(x).forEach(crawl); };
      crawl(json);
      for (const c of candidates){
        const p = Number(String(c.price ?? c.lowPrice ?? c.highPrice ?? "").replace(/,/g,"."));
        if (!Number.isNaN(p)) return { value: p, source: "json-ld" as const };
      }
    } catch {}
  }
  // data-attr
  const reData = /(data-(?:price|final-price|product-price)|itemprop="price"\s+content|content-price)=["']?([\d.,]+)["']?/i;
  const mData = reData.exec(html);
  if (mData){
    const v = parseNumberLocaleish(mData[2]);
    if (!Number.isNaN(v)) return { value: v, source: "data-attr" as const };
  }
  return { value: null as number|null, source: "none" as const };
}

// ===== Verification (Zyte on every request if enabled) =====
async function verifyItem(it:any){
  const res:any = {
    domain_ok:false, http_status:200, price_extracted:null as number|null, price_source:"none",
    found_shekel:false, price_matches:false, name_match:0, notes:""
  };

  // דומיין מאושר?
  if (!hostOK(it.product_url)){ res.notes = "domain not allowed"; return res; }
  res.domain_ok = true;

  try{
    if (AUTO_EXTRACT_MODE) {
      const zp = await extractProductWithZyte(it.product_url);
      if (!zp) { res.notes = "zyte-no-product"; return res; }
      const norm = normalizeZyteToLine(it, it.product_url, zp);

      res.price_extracted = (typeof norm.unit_price === "number") ? norm.unit_price : null;
      res.price_source = "zyte";
      res.found_shekel = (String(norm.currency || "").toUpperCase()==="ILS" || String(norm.currency || "").toUpperCase()==="NIS");

      const target = typeof it.unit_price === "number" ? it.unit_price : null;
      if (target != null && res.price_extracted != null){ res.price_matches = approxEq(res.price_extracted, target, 0.05); }

      const needle = [it.brand, it.size, it.name].filter(Boolean).join(" ").toLowerCase();
      const hay = (zp.name || "").toLowerCase();
      if (needle) {
        const toks = needle.split(" ").filter(t => t.length > 1);
        const hits = toks.filter(tok => hay.includes(tok)).length;
        res.name_match = hits / Math.max(1, toks.length);
      }

      res.notes = (res.price_extracted != null) ? (res.price_matches ? "OK" : "price-mismatch") : "no-price-found";
      return res;
    }

    // fallback ישן (אם מכבים AUTO_EXTRACT_MODE)
    const { status, text } = await fetchText(it.product_url);
    res.http_status = status;
    if (status !== 200){ res.notes = "non-200"; return res; }
    const { value, source } = extractPriceFromHtml(text);
    res.price_extracted = value;
    res.price_source = source;
    const target = typeof it.unit_price === "number" ? it.unit_price : null;
    if (target != null && value != null){ res.price_matches = approxEq(value, target, 0.05); }
    res.notes = (res.price_extracted != null) ? (res.price_matches ? "OK" : "price-mismatch") : "no-price-found";
    return res;

  }catch(e:any){
    res.notes = `zyte-error: ${e?.message || String(e)}`;
    return res;
  }
}

async function verifyStore(store:any, approvedBranches: Map<string, any>){
  const v:any = { approved_branch:false, verified_items:0, total_items:0, coverage_ratio:0, store_verified:false, issues:[] as string[] };
  if (!approvedBranches.has(store.branch_id)){ v.issues.push("branch_id not approved"); return v; }
  v.approved_branch = true;

  v.total_items = Array.isArray(store.basket) ? store.basket.length : 0;

  for (const it of (store.basket||[])){
    const proof = await verifyItem(it);
    it.verification = proof;
    if (proof.domain_ok) {
      if (typeof proof.price_extracted === "number") {
        v.verified_items++;
      }
    } else {
      v.issues.push(`item rejected: ${it.product_url || it.name} (${proof.notes})`);
    }
  }

  v.coverage_ratio = v.total_items ? v.verified_items / v.total_items : 0;
  v.store_verified = v.approved_branch && v.coverage_ratio >= COVERAGE_THRESHOLD;

  const approved = approvedBranches.get(store.branch_id)!;
  store.address = approved.address;
  store.branch_name = approved.branch_name;
  store.branch_url = approved.branch_url;
  store.distance_km = approved.distance_km;

  store.store_verification = v;
  return v;
}

// ===== API =====
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"]
}));

app.get("/api/health", (c)=>{
  const id = rid();
  const payload = {
    ok: true,
    model: OPENAI_MODEL,
    temperature: OPENAI_TEMP,
    has_openai_key: !!OPENAI_KEY,
    has_google_places_key: !!PLACES_KEY,
    zyte_enabled: AUTO_EXTRACT_MODE,
    has_zyte_key: !!ZYTE_API_KEY,
    allowed_mode: ALLOWED_MODE,
    allowed_domains: [...ALLOWED_DOMAINS],
    debug_enabled: DEBUG,
    requestId: id
  };
  info(id, "GET /api/health", payload);
  return c.json(payload);
});

// DEBUG: Preview prompt + branches (no model call)
app.get("/api/llm_preview", async (c)=>{
  if (!DEBUG) return c.json({ status:"forbidden", message:"Enable DEBUG=true to use /api/llm_preview" }, 403);
  const id = rid();
  const address = cleanText(c.req.query("address") || "");
  const radius_km = Number(c.req.query("radius_km") || "5");
  const list_text = cleanText(c.req.query("list_text") || "");
  if (!address || !list_text || !radius_km){
    return c.json({ status:"need_input", needed:["address","radius_km","list_text"], requestId:id }, 400);
  }
  const { branches, formatted_address } = await listApprovedBranches(id, address, radius_km);
  const userPrompt =
`address: ${address} (geocoded: ${formatted_address})
radius_km: ${radius_km}
list_text: ${list_text}

ALLOWED_DOMAINS: ${JSON.stringify([...ALLOWED_DOMAINS])}

APPROVED_BRANCHES (JSON):
${JSON.stringify(branches, null, 2)}

INSTRUCTIONS:
- Choose branches ONLY from APPROVED_BRANCHES by branch_id.
- Use ONLY ALLOWED_DOMAINS above.
- Return ONE function call (submit_results). No free text.`;
  return c.json({ status:"ok", debug:{ instructions: PROMPT_SYSTEM, user_input: userPrompt }, requestId: id });
});

// Main search
app.post("/api/search", async (c)=>{
  const id = rid();
  try{
    const body = await c.req.json().catch(()=> ({}));
    info(id, "POST /api/search body", body);

    const address   = cleanText(String(body?.address ?? "").trim());
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = cleanText(String(body?.list_text ?? "").trim());
    const show_all  = !!body?.show_all;

    const miss:string[]=[];
    if(!address)   miss.push("address");
    if(!radius_km) miss.push("radius_km");
    if(!list_text) miss.push("list_text");
    if (miss.length){
      return c.json({ status:"need_input", needed: miss, requestId:id }, 400);
    }

    // 1) סניפים אמיתיים
    const { branches, formatted_address } = await listApprovedBranches(id, address, radius_km);
    const approvedMap = new Map<string, Branch>(branches.map(b => [b.branch_id, b]));

    // 2) פרומפט משתמש
    const basePrompt =
`address: ${address} (geocoded: ${formatted_address})
radius_km: ${radius_km}
list_text: ${list_text}

ALLOWED_DOMAINS: ${JSON.stringify([...ALLOWED_DOMAINS])}

APPROVED_BRANCHES (JSON):
${JSON.stringify(branches, null, 2)}

ENFORCEMENTS:
- Choose branches ONLY from APPROVED_BRANCHES by branch_id.
- Use ONLY ALLOWED_DOMAINS above.
- Return ONE function call (submit_results). No free text.`;

    // 3) LLM
    const first = await callOpenAIOnce(PROMPT_SYSTEM, basePrompt, id);

    // 4) אימות תוצאות (Zyte בכל בקשה)
    const parsed = first.parsed as any;
    if (!parsed?.results || !Array.isArray(parsed.results)) {
      throw new HttpError(400, "Bad results shape from model", { openai_request_id: first.request_id });
    }

    let issues: string[] = [];
    for (const s of parsed.results) {
      const v = await verifyStore(s, approvedMap);
      if (!v.store_verified) issues.push(`store not verified (branch=${s.branch_id}): ${v.issues.join("; ")}`);
    }

    const verifiedOnly = parsed.results.filter((s:any)=> s.store_verification?.store_verified);
    const finalResults = show_all ? parsed.results : verifiedOnly;

    finalResults.sort((a:any,b:any)=> (a.total_price??999999) - (b.total_price??999999));
    finalResults.forEach((r:any,i:number)=> r.rank = i+1);

    const payload:any = { status:"ok", results: finalResults, requestId:id, openai_request_id: first.request_id ?? undefined };
    if (DEBUG || body?.include_debug) payload.debug = {
      issues,
      approved_branches_count: branches.length,
      openai_raw_excerpt: JSON.stringify(first.raw).slice(0, SAFE_DEBUG_MAX)
    };
    return c.json(payload, 200);

  }catch(e:any){
    const status = typeof e?.status === "number" ? e.status : 500;
    const message = e?.message || String(e);
    const payload:any = { status:"error", message, requestId:id };
    if (e?.payload) payload.details = e.payload;
    err(id, "search handler failed", { status, message, details: e?.payload });
    return c.json(payload, status);
  }
});

// ===== Static UI =====
app.use("/public/*", serveStatic({ root:"./" }));
app.use("/assets/*", serveStatic({ root:"./" }));

async function tryIndex(): Promise<string|null> {
  try { return await Deno.readTextFile("./public/index.html"); }
  catch { return null; }
}

app.get("/", async (c)=>{
  const id = rid();
  const html = await tryIndex();
  if (html){
    info(id, "Serving ./public/index.html");
    return c.newResponse(html, 200, { "content-type":"text/html; charset=utf-8" });
  }
  return c.newResponse(
    "<!doctype html><meta charset=utf-8><title>CartCompare AI</title><p>Upload <code>public/index.html</code> to show the UI.</p>",
    200
  );
});

app.notFound(async (c)=>{
  const html = await tryIndex();
  return c.newResponse(html ?? "<p>Not found</p>", 404, { "content-type":"text/html; charset=utf-8" });
});

Deno.serve(app.fetch);
