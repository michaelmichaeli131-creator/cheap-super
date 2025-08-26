// server_deno.ts
// Hono via npm + Anthropic Claude + Google CSE
//
// Flow: client -> /api/search -> Google CSE (snippets) -> Claude messages -> strict JSON
//
// ENV (Deno Deploy → Settings → Environment Variables):
// ANTHROPIC_API_KEY=sk-ant-...
// ANTHROPIC_MODEL=claude-sonnet-4-20250514
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

// ===== Utils =====
function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }

function extractJson(text:string){
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a>=0 && b>a) { try { return JSON.parse(text.slice(a, b+1)); } catch {} }
  return null;
}

function hostnameOf(u: string): string {
  try { return new URL(u).hostname || ""; } catch { return ""; }
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
1) Parse the shopping list into concrete items.
2) Use ONLY the web_snippets *as live sources* to find realistic prices.
3) Return 3–4 stores near the given address within the radius.
4) Sort stores cheapest→expensive by total_price.

STRICT JSON OUTPUT ONLY (no extra text).
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

  const res = await fetch(url.toString());
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new HttpError(res.status, `CSE ${res.status}: ${JSON.stringify(data)}`);

  return (data.items||[]).map((it:any)=>({
    title: String(it.title||""),
    snippet: String(it.snippet||""),
    url: String(it.link||"")
  }));
}

function dedupByUrl(items:{title:string;snippet:string;url:string}[]){
  const seen = new Set<string>();
  return items.filter(it => {
    const u = it.url.trim();
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

// ===== Claude =====
async function callClaude(id:string, systemPrompt:string, userPayload:string){
  if(!ANTHROPIC_KEY) throw new HttpError(500, "Missing ANTHROPIC_API_KEY");
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
  });
  const j = await resp.json().catch(()=> ({}));
  if (!resp.ok) throw new HttpError(resp.status, `Claude ${resp.status}: ${JSON.stringify(j)}`);

  const text = Array.isArray(j.content) ? (j.content.find((p:any)=>p.type==="text")?.text ?? "") : "";
  if (!text) throw new HttpError(502, "Claude empty content");
  const parsed = extractJson(text);
  return parsed || { status:"ok", results:[], raw:text };
}

// ===== API =====
app.use("/api/*", cors());

app.get("/api/health", (c)=>{
  return c.json({
    ok:true,
    model: ANTHROPIC_MODEL,
    has_anthropic_key: !!ANTHROPIC_KEY,
    has_google_cse_key: !!GOOGLE_CSE_KEY,
    has_google_cse_cx: !!GOOGLE_CSE_CX,
    requestId: rid()
  });
});

// ---- Debug: raw Google CSE ----
app.get("/api/cse", async (c) => {
  if (!DEBUG) return c.json({ status:"forbidden", message:"Enable DEBUG=true to use /api/cse" }, 403);
  const id = rid();
  const q = c.req.query("q") || "";
  const num = Number(c.req.query("num") || "8");
  if (!q) return c.json({ status:"need_input", needed:["q"], requestId:id }, 400);

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_CSE_KEY);
  url.searchParams.set("cx", GOOGLE_CSE_CX);
  url.searchParams.set("q", q);
  url.searchParams.set("num", String(num));
  url.searchParams.set("hl", "he");

  const res = await fetch(url.toString());
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) return c.json({ status:"error", http_status:res.status, google:data, requestId:id }, res.status);

  const items = (data.items||[]).map((it:any)=>({ title:it.title, snippet:it.snippet, url:it.link }));
  return c.json({ status:"ok", q, num, items, google:data, requestId:id });
});

// ---- Debug: preview payload to LLM ----
app.get("/api/llm_preview", async (c) => {
  if (!DEBUG) return c.json({ status:"forbidden", message:"Enable DEBUG=true to use /api/llm_preview" }, 403);
  const id = rid();
  const address = c.req.query("address") || "";
  const radius_km = Number(c.req.query("radius_km") || "5");
  const list_text = c.req.query("list_text") || "";
  if (!address || !list_text) return c.json({ status:"need_input", needed:["address","list_text"], requestId:id }, 400);

  const [r1, r2] = await Promise.all([
    googleCse(id, `site:co.il ${list_text} מחיר קנייה ${address}`, 8),
    googleCse(id, `${list_text} מחירים ${address}`, 8)
  ]);
  const snippets = dedupByUrl([...r1, ...r2]);
  const domains = snippets.reduce((acc:Record<string,number>, s)=>{ const h=hostnameOf(s.url); if(h) acc[h]=(acc[h]||0)+1; return acc; },{});
  const payload =
`address: ${address}
radius_km: ${radius_km}
list_text: ${list_text}

web_snippets:
${snippets.map(s=>`- title: ${s.title}\n  snippet: ${s.snippet}\n  url: ${s.url}`).join("\n")}
`;

  return c.json({ status:"ok", debug:{ snippets, domains, llm_payload: payload }, requestId:id });
});

// ---- Main search ----
app.post("/api/search", async (c)=>{
  const id = rid();
  try{
    const body = await c.req.json().catch(()=> ({}));
    const address = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    if(!address || !radius_km || !list_text)
      return c.json({ status:"need_input", needed:["address","radius_km","list_text"], requestId:id }, 400);

    const [r1, r2] = await Promise.all([
      googleCse(id, `site:co.il ${list_text} מחיר קנייה ${address}`, 8),
      googleCse(id, `${list_text} מחירים ${address}`, 8)
    ]);
    const snippets = dedupByUrl([...r1, ...r2]);
    const domains = snippets.reduce((acc:Record<string,number>, s)=>{ const h=hostnameOf(s.url); if(h) acc[h]=(acc[h]||0)+1; return acc; },{});
    const userPayload =
`address: ${address}
radius_km: ${radius_km}
list_text: ${list_text}

web_snippets:
${snippets.map(s=>`- title: ${s.title}\n  snippet: ${s.snippet}\n  url: ${s.url}`).join("\n")}
`;

    const out = await callClaude(id, PROMPT_CLAUDE, userPayload);
    if (!out || out.status!=="ok" || !Array.isArray(out.results))
      return c.json({ status:"no_results", results:[], debug:{ snippets, domains }, requestId:id }, 502);

    const debug = (DEBUG||body?.include_snippets) ? { snippets, domains, llm_payload: userPayload } : undefined;
    return c.json({ ...out, requestId:id, ...(debug?{debug}: {}) });
  }catch(e:any){
    return c.json({ status:"error", message:e?.message||String(e), requestId:id }, e?.status||500);
  }
});

// ===== Static UI =====
app.use("/public/*", serveStatic({ root:"./" }));
app.use("/assets/*", serveStatic({ root:"./" }));

app.get("/", async (c)=>{
  try{ const html = await Deno.readTextFile("./public/index.html"); return c.newResponse(html,200,{"content-type":"text/html"});}
  catch{ return c.newResponse("<p>Upload public/index.html</p>",200); }
});

app.notFound((c)=> c.text("Not found",404));

Deno.serve(app.fetch);
