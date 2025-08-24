// server_deno.ts
// Hono + OpenAI Responses API + Google CSE (Programmable Search)
// שני מצבים: ChatGPT רגיל (אין חיפוש) / ChatGPT + חיפוש ברשת בלבד (use_web=true)
//
// לוגים מפורטים עם requestId לכל שלב ושגיאה.

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";
import OpenAI from "npm:openai";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5";

const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") || "";
const GOOGLE_CSE_CX = Deno.env.get("GOOGLE_CSE_CX") || "";

const WEB_SEARCH_MAX_RESULTS = Math.max(1, Number(Deno.env.get("WEB_SEARCH_MAX_RESULTS") || 6));
const PER_PAGE_CHAR_LIMIT = Math.max(1000, Number(Deno.env.get("PER_PAGE_CHAR_LIMIT") || 20000));
const TOTAL_CORPUS_CHAR_LIMIT = Math.max(5000, Number(Deno.env.get("TOTAL_CORPUS_CHAR_LIMIT") || 60000));
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";

// ===== Clients =====
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

app.use("/api/*", cors({
origin: "*",
allowMethods: ["GET","POST","OPTIONS"],
allowHeaders: ["Content-Type","Authorization"],
}));

// ===== Utils & Types =====
type ChatMsg = { role: "system" | "user"; content: string };
type SourceDoc = { url: string; excerpt: string };
function rid() { return crypto.randomUUID(); }
function logInfo(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function logError(id:string, msg:string, err?:unknown){ console.error(`[${id}] ERROR: ${msg}`, err ?? ""); }

function extractJsonBlock(s: string): string {
const start = s.indexOf("{"); const end = s.lastIndexOf("}");
return (start>=0 && end>start) ? s.slice(start,end+1) : s.trim();
}
function safeParse<T=unknown>(t: string): {ok:true; data:T}|{ok:false; error:string} {
try { return { ok:true, data: JSON.parse(t) as T }; } catch(e){ return { ok:false, error: (e as Error).message || "JSON parse error" }; }
}
function truncate(s:string, max:number){ return s.length>max ? s.slice(0, max) : s; }
function isPlaceholderDomain(d:string){
const x = (d||"").toLowerCase();
return !x || x==="example.com" || x.endsWith(".example") || x==="localhost" || x==="127.0.0.1";
}
function isLikelyProductUrl(u:string){
try{ const url = new URL(u); return /^https?:$/.test(url.protocol) && !!url.hostname && url.pathname.length>1; } catch { return false; }
}
function cityHintFromAddress(addr:string){
const seg = addr.split(",")[0]?.trim() || addr.trim();
return seg.split(/\s+/)[0] || seg;
}
function buildQueries(listText: string, cityHint: string): string[] {
const items = listText.split(/[,;\n]/).map(s=>s.trim()).filter(Boolean).slice(0,6);
const qs: string[] = [];
for (const it of items) {
qs.push(`${it} מחיר ${cityHint}`);
qs.push(`${it} קניה אונליין ${cityHint}`);
}
qs.push(`מחירי סופר ${cityHint}`);
qs.push(`השוואת מחירים ${cityHint}`);
return Array.from(new Set(qs)).slice(0, 8);
}

// ===== Google CSE =====
type WebHit = { url: string; snippet: string };

async function googleCseSearch(id:string, q: string, count = WEB_SEARCH_MAX_RESULTS): Promise<WebHit[]> {
if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) throw new Error("Missing GOOGLE_CSE_KEY or GOOGLE_CSE_CX");
const url = new URL("https://www.googleapis.com/customsearch/v1");
url.searchParams.set("key", GOOGLE_CSE_KEY);
url.searchParams.set("cx", GOOGLE_CSE_CX);
url.searchParams.set("q", q);
url.searchParams.set("num", String(Math.min(10, Math.max(1, count))));
url.searchParams.set("hl", "he");
url.searchParams.set("lr", "lang_iw");

const res = await fetch(url.toString());
if (!res.ok) {
const text = await res.text();
logError(id, `Google CSE failed: ${res.status}`, text);
throw new Error(`Google CSE failed: ${res.status}`);
}
const json = await res.json();
const items = json.items ?? [];
const hits = items.map((it: any) => ({
url: String(it.link || ""),
snippet: String(it.snippet || it.title || "")
})).filter(h => /^https?:\/\//i.test(h.url));
if (DEBUG) logInfo(id, `CSE hits for "${q}" → ${hits.length}`);
return hits;
}

async function fetchPageText(id:string, url: string): Promise<string> {
try {
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
logError(id, `fetchPageText not ok: ${res.status}`, url);
return "";
}
const html = await res.text();
const text = html
.replace(/<script[\s\S]*?<\/script>/gi, " ")
.replace(/<style[\s\S]*?<\/style>/gi, " ")
.replace(/<[^>]+>/g, " ")
.replace(/\s+/g, " ")
.trim();
return truncate(text, PER_PAGE_CHAR_LIMIT);
} catch (e) {
logError(id, "fetchPageText exception", { url, e });
return "";
}
}

async function webGather(id:string, address: string, listText: string): Promise<{sources:SourceDoc[], queries:string[]}> {
const city = cityHintFromAddress(address);
const queries = buildQueries(listText, city);
const results: SourceDoc[] = [];
for (const q of queries) {
const hits = await googleCseSearch(id, q, WEB_SEARCH_MAX_RESULTS);
for (const h of hits) {
const txt = await fetchPageText(id, h.url);
if (txt.length < 400) continue;
results.push({ url: h.url, excerpt: txt });
if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
}
if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
}

let total = 0;
const picked: SourceDoc[] = [];
for (const r of results) {
const l = r.excerpt.length;
if (total + l > TOTAL_CORPUS_CHAR_LIMIT) break;
picked.push(r);
total += l;
}
if (DEBUG) logInfo(id, `webGather picked=${picked.length}`, picked.map(s=>s.url));
return { sources: picked, queries };
}

// ===== OpenAI =====
async function callOpenAI(id:string, messages: ChatMsg[]): Promise<string> {
if (!openai) throw new Error("Missing OPENAI_API_KEY");
try{
const resp = await openai.responses.create({ model: OPENAI_MODEL, input: messages });
const text = resp.output_text ?? "";
if (!text) logError(id, "OpenAI output_text empty", resp);
return text;
}catch(e){
logError(id, "OpenAI call failed", e);
throw e;
}
}

// ===== Shape helpers =====
function looksLikeStoreArray(x:any): boolean {
return Array.isArray(x) && x.length>0 && typeof x[0] === "object";
}
function coerceToResultsShape(data:any){
if (!data || typeof data !== "object") {
if (Array.isArray(data)) return { status:"ok", results:data };
return null;
}
if (Array.isArray(data.results)) {
if (!data.status) data.status = "ok";
return data;
}
if (looksLikeStoreArray((data as any).stores)) return { status:"ok", results:(data as any).stores };
if (looksLikeStoreArray((data as any).items)) return { status:"ok", results:(data as any).items };
if (looksLikeStoreArray((data as any).data)) return { status:"ok", results:(data as any).data };
if (looksLikeStoreArray((data as any).output)) return { status:"ok", results:(data as any).output };
const k = Object.keys(data).find(key => looksLikeStoreArray((data as any)[key]));
if (k) return { status:"ok", results:(data as any)[k] };
return null;
}

// ===== API =====
app.get("/api/health", (c) => {
const id = rid();
const payload = {
ok: true,
openai_model: OPENAI_MODEL,
has_openai_key: !!OPENAI_KEY,
has_google_cse_key: !!GOOGLE_CSE_KEY,
has_google_cse_cx: !!GOOGLE_CSE_CX,
web_search_max_results: WEB_SEARCH_MAX_RESULTS,
debug: DEBUG,
requestId: id
};
logInfo(id, "GET /api/health", payload);
return c.json(payload);
});

app.post("/api/search", async (c) => {
const id = rid();
try {
const body = await c.req.json().catch(()=> ({}));
const address = String(body?.address ?? "").trim();
const radius_km = Number(body?.radius_km ?? 0);
const list_text = String(body?.list_text ?? "").trim();
const mode = String(body?.mode ?? "openai").toLowerCase(); // "openai" | "openai_web_only"
const use_web = (mode === "openai_web_only"); // מחייב מקורות מהווב

if (DEBUG) logInfo(id, "POST /api/search body", body);

const needed: string[] = [];
if (!address) needed.push("address");
if (!radius_km || isNaN(radius_km)) needed.push("radius_km");
if (!list_text) needed.push("list_text");
if (needed.length){
const resp = { status:"need_input", needed, requestId:id };
logInfo(id, "need_input", resp);
return c.json(resp, 400);
}
if (!OPENAI_KEY){
const resp = { status:"error", message:"OPENAI_API_KEY is missing", requestId:id };
logError(id, "missing openai key");
return c.json(resp, 500);
}

// === Web gather (only if web-only mode) ===
let sources: SourceDoc[] = [];
let queries: string[] = [];
if (use_web) {
if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) {
const resp = { status:"error", message:"GOOGLE_CSE_KEY/GOOGLE_CSE_CX is missing (web-only mode)", requestId:id };
logError(id, "missing google cse env");
return c.json(resp, 500);
}
const gathered = await webGather(id, address, list_text);
sources = gathered.sources;
queries = gathered.queries;
if (!sources.length) {
const resp = { status:"no_results", message:"No web sources found (web-only mode).", provider:"openai", mode, requestId:id, debug:{ queries } };
logInfo(id, "no web sources", resp);
return c.json(resp, 200);
}
}

// === Prompts ===
const BASE_SYSTEM = (use_web ? `
You are an Israeli grocery price-comparison agent.
STRICT WEB-ONLY MODE: Use ONLY the provided SOURCES. Do NOT rely on prior knowledge. If an item's price cannot be verified from SOURCES, set unit_price = null and add a brief note. Never output unit_price = 0. Currency "₪". Output ONLY strict JSON { "status":"ok","results":[...] } sorted by total_price ascending.
` : `
You are an Israeli grocery price-comparison agent.
Try to be accurate. Prefer real Israeli brands. If unsure about a price, set unit_price = null (never 0) and add a brief note. Currency "₪". Output ONLY strict JSON { "status":"ok","results":[...] } sorted by total_price ascending.
`).trim();

const SOURCES = use_web
? `SOURCES (real excerpts with URLs):
${sources.map((s, i) => `[#${i+1}] URL: ${s.url}
EXCERPT: ${truncate(s.excerpt, 1500)}
`).join("\n")}`
: `SOURCES: (none provided; you may answer cautiously; if price not verifiable set unit_price=null)`;

const user = `
Address: ${address}
Radius_km: ${radius_km}
User list (free text; commas optional): ${list_text}

${SOURCES}

Rules:
- Return 3–4 stores (within radius), sorted cheapest-first.
- Each basket item MUST include brand (e.g., מי עדן, קלסברג, תנובה). If not provided, pick a common Israeli brand and add a short note.
- Never output unit_price = 0; if unsure, use null and add a short note.
- If you would return an array directly, WRAP it as: { "status": "ok", "results": [ ... ] }.
`.trim();

const messages: ChatMsg[] = [
{ role:"system", content: BASE_SYSTEM },
{ role:"user", content: user }
];

const raw = await callOpenAI(id, messages);
const rawText = extractJsonBlock(raw);
const parsed = safeParse<any>(rawText);
if (!parsed.ok) {
const resp = {
status: "error",
message: "LLM returned non-JSON text",
details: parsed.error,
raw_preview: String(rawText).slice(0, 1200),
provider:"openai",
mode,
requestId:id,
debug: use_web ? { queries, sources_count: sources.length, sample_urls: sources.slice(0,5).map(s=>s.url) } : undefined
};
logError(id, "parse json failed", resp);
return c.json(resp, 502);
}

let data = parsed.data;
if (!(data && data.status === "ok" && Array.isArray(data.results))) {
const coerced = coerceToResultsShape(data);
if (coerced) data = coerced;
}
if (!(data && data.status === "ok" && Array.isArray(data.results))) {
const resp = { status:"no_results", provider:"openai", mode, message:"Unexpected shape from LLM", raw:data, requestId:id };
logInfo(id, "unexpected shape", resp);
return c.json(resp, 200);
}

// === Normalize & validate ===
const cleaned:any[] = [];
for (const r of (data.results || [])) {
let validCount = 0;
for (const b of (r.basket || [])) {
const urlOk = isLikelyProductUrl(b.product_url || "");
const placeholder = isPlaceholderDomain(b.source_domain || "");
if (!urlOk || placeholder) {
b.notes = (b.notes||"") + " • קישור חשוד/placeholder";
}

if (!(typeof b.unit_price==="number" && b.unit_price>0 && b.unit_price<1999)) {
b.unit_price = null;
b.line_total = 0;
if (!/סומן כ-null/.test(b.notes||"")) {
b.notes = (b.notes||"") + " • מחיר לא נמצא/לא הגיוני — סומן כ-null";
}
} else {
b.line_total = +(Number(b.unit_price) * Number(b.quantity || 1)).toFixed(2);
validCount++;
}

if (typeof b.brand !== "string" || !b.brand.trim()) {
b.brand = "מותג נפוץ";
b.notes = (b.notes||"") + " • הוסף מותג כללי כי לא צוין";
}

if (typeof b.notes === "string") {
b.notes = b.notes.replace(/price may vary|~|≈|about/gi, "").trim();
}
}

if (validCount === 0) {
r.total_price = null;
r.notes = (r.notes || "") + " • אין מספיק מחירים תקפים — מוצג מידע חלקי";
} else {
r.total_price = +((r.basket || [])
.reduce((s:number,b:any)=> s + (typeof b.unit_price==="number" ? b.unit_price*(b.quantity||1) : 0), 0)
.toFixed(2));
}

cleaned.push(r);
}

if (!cleaned.length) {
const resp = {
status:"no_results",
provider:"openai",
mode,
message:"לא נמצאו חנויות. נסו להרחיב רדיוס, לציין מותג/נפח מדויק, או לחפש שוב.",
requestId:id
};
logInfo(id, "no cleaned results", resp);
return c.json(resp, 200);
}

cleaned.sort((a:any,b:any)=>{
const A = (typeof a.total_price === "number") ? a.total_price : Infinity;
const B = (typeof b.total_price === "number") ? b.total_price : Infinity;
return A - B;
});
cleaned.forEach((r:any,i:number)=> r.rank=i+1);

const payload:any = {
status:"ok",
provider:"openai",
mode,
results: cleaned,
requestId:id
};
if (DEBUG) {
payload.debug = use_web
? { queries, sources_count: sources.length, sample_urls: sources.slice(0,5).map(s=>s.url) }
: { note: "no web, normal ChatGPT" };
}
logInfo(id, "success", { count: cleaned.length });
return c.json(payload, 200);

} catch (err) {
logError(id, "unhandled error", err);
return c.json({ status:"error", message:String(err), requestId:id }, 500);
}
});

// ===== Static (serve your SPA if exists) =====
app.use("/assets/*", serveStatic({ root: "./public" }));
app.use("/img/*", serveStatic({ root: "./public" }));
app.use("/public/*", serveStatic({ root: "./public" }));

app.get("/", async (c) => {
try {
const html = await Deno.readTextFile("./public/index.html");
return c.newResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
} catch {
return c.newResponse(FALLBACK_HTML, 200, { "content-type": "text/html; charset=utf-8" });
}
});
app.notFound(async (c) => {
try {
const html = await Deno.readTextFile("./public/index.html");
return c.newResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
} catch {
return c.newResponse(FALLBACK_HTML, 200, { "content-type": "text/html; charset=utf-8" });
}
});

export default app;

const FALLBACK_HTML = `<!doctype html>
<html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CartCompare AI – Server Check</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f5f9ff;color:#0d1321;margin:0;padding:24px} .box{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:16px;box-shadow:0 10px 30px rgba(15,50,90,.08)}</style>
<div class="box">
<h2>CartCompare AI – שרת רץ</h2>
<p>בדיקת API: <code>/api/health</code> ו-<code>/api/search</code>.</p>
<p>לוגים זמינים בקונסול (requestId לכל בקשה).</p>
</div>
</html>`;