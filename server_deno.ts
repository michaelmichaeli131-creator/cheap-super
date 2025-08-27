// server_deno.ts (improved)
// Deno + Hono + OpenAI Responses API (web_search) + Google Places
// Hard server-side verification + timeouts, retries, and limited concurrency


import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";


const app = new Hono();


// ===== ENV =====
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1";
const PLACES_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";
const TEMP_STR = Deno.env.get("OPENAI_TEMPERATURE");
const OPENAI_TEMP = (TEMP_STR!=null && TEMP_STR.trim()!=="") ? Number(TEMP_STR) : 0;


// ===== Networking defaults =====
const UA = "CartCompareAI/1.0 (Deno)";
const FETCH_TIMEOUT_MS = 15000; // retailers pages, HTML, etc.
const OPENAI_TIMEOUT_MS = 45000; // LLM call
const PLACES_TIMEOUT_MS = 15000; // Google APIs
const VERIFY_CONCURRENCY = 5; // verify items in parallel (pool)


// ===== Utils =====
const SAFE_DEBUG_MAX = 2500;
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
s = s.replace(/&#x([0-9a-fA-F]+);/g, (_:any,h:string)=> String.fromCharCode(parseInt(h,16)));
s = s.replace(/&#(\d+);/g, (_:any,d:string)=> String.fromCharCode(parseInt(d,10)));
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
function cleanText(s: string, maxLen = 400): string {
const out = normalizeSpaces(stripBidiControls(decodeHtmlEntities(s)));
return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}
function haversineKm(a:{lat:number,lng:number}, b:{lat:number,lng:number}){
const R=6371; const dLat=(b.lat-a.lat)*Math.PI/180; const dLng=(b.lng-a.lng)*Math.PI/180;
const s=Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
return 2*R*Math.asin(Math.sqrt(s));
}
function parseNumberLocaleish(x:string){
return Number(
x
.replace(/\u200f|\u200e/g, "")
} as const;
// ===== OpenAI Responses API =====
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
temperature: Number.isFinite(OPENAI_TEMP) ? OPENAI_TEMP : 0,
max_output_tokens: 2200
};


const jsonOrText = await retry(async ()=>{
const r = await fetchWithTimeout("https://api.openai.com/v1/responses", {
method: "POST",
headers: {
"authorization": `Bearer ${OPENAI_KEY}`,
"content-type": "application/json",
"user-agent": UA
},
body: JSON.stringify(body)
}, OPENAI_TIMEOUT_MS);
}
function approxEq(a:number,b:number,pct=0.05){
const d = Math.abs(a-b); return d <= Math.max(1, b*pct);
}


async function verifyItem(it:any){
const res:any = {
domain_ok:false, http_status:0, price_extracted:null as number|null, price_source:"none",
found_shekel:false, price_matches:false, name_match:0, notes:""
};


if (!hostOK(it.product_url)){ res.notes = "domain not allowed"; return res; }
res.domain_ok = true;


const { status, text } = await fetchText(it.product_url);
res.http_status = status;
if (status !== 200){ res.notes = "non-200"; return res; }


const { value, source } = extractPriceFromHtml(text);
res.price_extracted = value;
res.price_source = source;
res.found_shekel = source === "shekel-sign";


const target = typeof it.unit_price === "number" ? it.unit_price : null;
if (target != null && value != null){ res.price_matches = approxEq(value, target, 0.05); }


const needle = [it.brand, it.size, it.name].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
if (needle){
const lc = text.toLowerCase();
const toks = needle.toLowerCase().split(" ").filter(t=>t.length>1);
const hits = toks.filter(tok => lc.includes(tok)).length;
res.name_match = hits / Math.max(1, toks.length);
}


res.notes = (res.domain_ok && res.http_status===200 && (res.found_shekel || res.price_source==="json-ld") && (res.price_matches || value==null))
? "OK" : "mismatch";
return res;
}


async function verifyStore(store:any, approvedBranches: Map<string, any>){
const v:any = { approved_branch:false, verified_items:0, total_items:0, coverage_ratio:0, store_verified:false, issues:[] as string[] };
if (!approvedBranches.has(store.branch_id)){ v.issues.push("branch_id not approved"); return v; }
v.approved_branch = true;


v.total_items = Array.isArray(store.basket) ? store.basket.length : 0;


const items = (store.basket||[]);
const proofs = await mapPool(items, VERIFY_CONCURRENCY, async (it)=> verifyItem(it));


proofs.forEach((proof, idx)=>{
const it = items[idx];
it.verification = proof;
});
// Main search
app.post("/api/search", async (c)=>{
const id = rid();
try{
const body = await c.req.json().catch(()=> ({}));
info(id, "POST /api/search body", body);


let address = cleanText(String(body?.address ?? "").trim(), 200);
const radius_km = Math.max(1, Number(body?.radius_km ?? 0));
let list_text = cleanText(String(body?.list_text ?? "").trim(), 800);
const show_all = !!body?.show_all;


const miss:string[]=[];
if(!address) miss.push("address");
if(!radius_km) miss.push("radius_km");
if(!list_text) miss.push("list_text");
if (miss.length){
return c.json({ status:"need_input", needed: miss, requestId:id }, 400);
}


// 1) Branches
const { branches, formatted_address } = await listApprovedBranches(id, address, radius_km);
const approvedMap = new Map<string, Branch>(branches.map(b => [b.branch_id, b]));


// 2) Prompt
const basePrompt =
`address: ${address} (geocoded: ${formatted_address})
radius_km: ${radius_km}
list_text: ${list_text}


ALLOWED_DOMAINS: ${JSON.stringify([...APPROVED_DOMAINS])}


APPROVED_BRANCHES (JSON):
${JSON.stringify(branches, null, 2)}


ENFORCEMENTS:
- Choose branches ONLY from APPROVED_BRANCHES by branch_id.
- Prices ONLY from ALLOWED_DOMAINS with "₪" in the page, or JSON-LD ILS.
- If exact item unavailable, use nearest substitute (substitution=true) with ppu and notes.
- Return ONE function call (submit_results). No free text.`;


// 3) LLM
const first = await callOpenAIOnce(PROMPT_SYSTEM, basePrompt, id);


Deno.serve(app.fetch);