// server_deno.ts
// Hono via npm + Anthropic Claude + Google CSE
// Flow: client -> /api/search -> Google CSE (snippets) -> Claude messages -> strict JSON
//
// ENV (Deno Deploy → Settings → Environment Variables):
// ANTHROPIC_API_KEY=sk-ant-...
// ANTHROPIC_MODEL=claude-sonnet-4-20250514   <-- ברירת מחדל מעודכנת
// GOOGLE_CSE_KEY=AIza...
// GOOGLE_CSE_CX=xxxxxxxxxxxxxxxxx
// DEBUG=true (optional)

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";

const app = new Hono();

// ===== ENV =====
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";
const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") ?? "";
const GOOGLE_CSE_CX = Deno.env.get("GOOGLE_CSE_CX") ?? "";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";

const RECOMMENDED_MODELS = new Set<string>([
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022"
]);

// ===== Utils / Logging =====
function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }

function extractJson(text:string){
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const s = fence[1].trim();
    try { return JSON.parse(s); } catch {}
  }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a>=0 && b>a) {
    const s = text.slice(a, b+1);
    try { return JSON.parse(s); } catch {}
  }
  return null;
}

class HttpError extends Error {
  status: number;
  constructor(status:number, message:string){ super(message); this.status = status; }
}

// ===== Prompt =====
const PROMPT_CLAUDE = `
You are a price-comparison agent.

INPUTS YOU GET:
- address (city/street/country)
- radius_km (numeric)
- list_text (free-form shopping list)
- web_snippets: a list of search results (title, snippet, url) gathered just now.

TASK:
1) Parse the shopping list into concrete items (name, quantity, brand if known, size when obvious).
2) Use ONLY the web_snippets *as live sources* to find realistic prices from real stores (supermarkets, e-commerce, price-comparison sites).
3) Return 3–4 stores near the given address within the radius. If exact distance is unknown from snippets, estimate.
4) Sort stores cheapest→expensive by total_price.

STRICT JSON OUTPUT ONLY (no extra text):
{
"status": "ok",
"results": [
{
"rank": 1,
"store_name": "string",
"address": "string",
"distance_km": 2.1,
"currency": "₪",
"total_price": 123.45,
"notes": "optional string",
"basket": [
{
"name": "string",
"brand": "string (or empty)",
"quantity": 1,
"unit_price": 12.34,
"line_total": 12.34,
"product_url": "https://...",
"source_domain": "example.co.il",
"match_confidence": 0.0–1.0,
"substitution": false,
"notes": "optional"
}
],
"match_overall": 0.0–1.0
}
]
}

HARD RULES:
- Use the snippets for evidence. Prefer product/store pages over articles/blogs.
- Always include product_url & source_domain for each basket item if available.
- If price not explicitly found, estimate reasonably BUT mark lower confidence (e.g. 0.4) and add "notes".
- No zeros unless the page says 0.
- Currency "₪" for Israel; otherwise use local currency symbol.
- ABSOLUTELY NO TEXT OUTSIDE JSON.
`.trim();

// ===== Google CSE =====
async function googleCse(id:string, q:string, num=8){
  if(!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) throw new HttpError(500, "Missing GOOGLE_CSE_KEY/GOOGLE_CSE_CX");
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_CSE_KEY);
  url.searchParams.set("cx", GOOGLE_CSE_CX);
  url.searchParams.set("q", q);
  url.searchParams.set("num", String(num));
  url.searchParams.set("hl", "he");

  const res = await fetch(url.toString()).catch((e)=>{ throw new HttpError(502, `CSE fetch error: ${e?.message || String(e)}`); });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) {
    err(id, "CSE bad status", data);
    throw new HttpError(res.status, `CSE ${res.status}: ${JSON.stringify(data)}`);
  }
  const items = (data.items||[]).map((it:any)=>({
    title: String(it.title||""),
    snippet: String(it.snippet||""),
    url: String(it.link||"")
  }));
  if (DEBUG) info(id, "CSE items", items.length);
  return items;
}

function dedupByUrl(items:{title:string;snippet:string;url:string}[]){
  const seen = new Set<string>();
  const out:any[] = [];
  for (const it of items){
    const u = it.url.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(it);
  }
  return out;
}

// ===== Claude =====
async function callClaude(id:string, systemPrompt:string, userPayload:string){
  if(!ANTHROPIC_KEY) throw new HttpError(500, "Missing ANTHROPIC_API_KEY");
  if (!RECOMMENDED_MODELS.has(ANTHROPIC_MODEL)) {
    info(id, `Model "${ANTHROPIC_MODEL}" not in recommended list (continuing).`);
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version":"2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [ { role:"user", content: userPayload } ]
    })
  }).catch((e)=>{ throw new HttpError(502, `Claude fetch error: ${e?.message || String(e)}`); });

  const j = await resp.json().catch(()=> ({}));
  if (!resp.ok){
    const et = j?.error?.type;
    const em = j?.error?.message || "";
    if (et === "not_found_error" || /model/i.test(em)) {
      throw new HttpError(
        400,
        `Model "${ANTHROPIC_MODEL}" לא נתמך או אינו זמין.\n` +
        `עדכן ENV:\nANTHROPIC_MODEL=claude-sonnet-4-20250514\nאו: claude-3-7-sonnet-20250219`
      );
    }
    err(id, "Claude bad status", j);
    throw new HttpError(resp.status, `Claude ${resp.status}: ${JSON.stringify(j)}`);
  }

  const text = Array.isArray(j.content)
    ? (j.content.find((p:any)=>p.type==="text")?.text ?? "")
    : "";
  if (!text) throw new HttpError(502, "Claude empty content");

  const parsed = extractJson(text);
  if (parsed) return parsed;
  return { status:"ok", results:[], raw:text };
}

// ===== API =====
app.use("/api/*", cors({
  origin:"*",
  allowMethods:["GET","POST","OPTIONS"],
  allowHeaders:["Content-Type","Authorization"]
}));

app.get("/api/health", (c)=>{
  const id = rid();
  const payload = {
    ok:true,
    model: ANTHROPIC_MODEL,
    recommended: RECOMMENDED_MODELS.has(ANTHROPIC_MODEL),
    has_anthropic_key: !!ANTHROPIC_KEY,
    has_google_cse_key: !!GOOGLE_CSE_KEY,
    has_google_cse_cx: !!GOOGLE_CSE_CX,
    requestId: id
  };
  info(id, "GET /api/health", payload);
  return c.json(payload);
});

app.post("/api/search", async (c)=>{
  const id = rid();
  try{
    const body = await c.req.json().catch(()=> ({}));
    info(id, "POST /api/search body", body);

    const address = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();

    const miss:string[]=[];
    if(!address) miss.push("address");
    if(!radius_km) miss.push("radius_km");
    if(!list_text) miss.push("list_text");
    if (miss.length){
      return c.json({ status:"need_input", needed: miss, requestId:id }, 400);
    }

    const wantSnippets =
      DEBUG ||
      c.req.query("debug") === "1" ||
      (typeof body?.include_snippets === "boolean" && body.include_snippets === true);

    const q1 = `site:co.il ${list_text} מחיר קנייה ${address}`;
    const q2 = `${list_text} מחירים ${address}`;

    const [r1,r2] = await Promise.all([googleCse(id,q1,8), googleCse(id,q2,8)]);
    const snippets = dedupByUrl([...r1, ...r2]);

    const userPayload =
`address: ${address}
radius_km: ${radius_km}
list_text: ${list_text}

web_snippets:
${snippets.map(s=>`- title: ${s.title}\n  snippet: ${s.snippet}\n  url: ${s.url}`).join("\n")}
`.trim();

    const out = await callClaude(id, PROMPT_CLAUDE, userPayload);

    if (!out || out.status!=="ok" || !Array.isArray(out.results)) {
      info(id, "Unexpected Claude shape", out);
      return c.json({
        status:"no_results",
        message:"Unexpected shape from LLM",
        results:[],
        debug: wantSnippets ? { snippets } : undefined,
        requestId:id
      }, 502);
    }

    const payload = wantSnippets ? { ...out, debug: { snippets }, requestId:id } : { ...out, requestId:id };
    return c.json(payload, 200);

  }catch(e:any){
    const status = typeof e?.status === "number" ? e.status : 500;
    const message = e?.message || String(e);
    err(id, "search handler failed", { status, message });
    return c.json({ status:"error", message, requestId:id }, status);
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
  return c.newResponse(`<!doctype html><meta charset=utf-8><title>CartCompare AI</title><p>Upload <code>public/index.html</code> to show the UI.</p>`, 200);
});

app.notFound(async (c)=>{
  const html = await tryIndex();
  return c.newResponse(html ?? "<p>Not found</p>", 200, { "content-type":"text/html; charset=utf-8" });
});

Deno.serve(app.fetch);
