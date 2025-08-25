// server_deno.ts
// Hono via npm + OpenAI + Google CSE
// מגיש SPA מתוך ./public (index.html), עם fallback והודעות דיבוג ברורות

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") ?? "";
const GOOGLE_CSE_CX  = Deno.env.get("GOOGLE_CSE_CX")  ?? "";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";

function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }

// ===== PROMPT (ChatGPT-only, חופשי – בלי הגנות) =====
const PROMPT_FREE = `
You are a shopping assistant AI.

The user will provide:
- Address (city/street)
- Search radius in kilometers
- Shopping list in free text

Your task:
1) Parse the shopping list into structured items:
   - name (string)
   - quantity (number or string, keep as written if unclear)
   - brand (string, if known; otherwise leave empty or guess a common brand)
   - unit_price (string or number, can be an estimate, a range, or "unknown")
   - line_total (string or number, can be approximate, e.g. "~25₪")
   - substitution (boolean, true if you guessed a replacement)
   - notes (string, optional comments)

2) Aggregate items into a basket.

3) Suggest 3–4 nearby stores (you may invent realistic ones if no real data).
   Each store:
   - store_name
   - address
   - distance_km
   - basket (items as above)
   - total_price (string or number, can be approximate)
   - currency: "₪"

Important:
- Never leave fields out.
- It's allowed to invent/estimate.
- Do NOT use 0 unless the user wrote 0.
- Output STRICT JSON only:
{ "status":"ok", "results":[ ... ] }
`.trim();

// ===== Middleware =====
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

// הגשת קבצים סטטיים מתוך ./public  (תמונות, CSS, JS וכו')
app.use("/public/*", serveStatic({ root: "./" }));
app.use("/assets/*", serveStatic({ root: "./" }));
app.use("/img/*",    serveStatic({ root: "./" }));

// ===== Helpers =====
async function callOpenAI(id:string, prompt:string, input:string){
  if(!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role:"system", content: prompt },
      { role:"user",   content: input  },
    ],
    temperature: 0.7,
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) {
    err(id, "OpenAI bad status", j);
    throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j)}`);
  }
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI empty content");

  try {
    return JSON.parse(text);
  } catch {
    err(id, "OpenAI returned non-JSON (passthrough)", text);
    return { status:"ok", results:[], raw:text };
  }
}

async function googleCseSearch(id:string, query:string){
  if(!GOOGLE_CSE_KEY || !GOOGLE_CSE_CX) throw new Error("Missing GOOGLE_CSE_KEY/GOOGLE_CSE_CX");
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_CSE_KEY);
  url.searchParams.set("cx",  GOOGLE_CSE_CX);
  url.searchParams.set("q",   query);
  url.searchParams.set("num", "6");
  url.searchParams.set("hl", "he");
  url.searchParams.set("lr", "lang_iw");

  const res = await fetch(url.toString());
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) {
    err(id, "CSE bad status", data);
    throw new Error(`CSE ${res.status}: ${JSON.stringify(data)}`);
  }
  return (data.items||[]).map((it:any)=>({
    title: String(it.title||""),
    link:  String(it.link||""),
    snippet:String(it.snippet||"")
  }));
}

// ===== API =====
app.get("/api/health", (c)=>{
  const id = rid();
  const payload = {
    ok:true,
    openai_model: OPENAI_MODEL,
    has_openai_key: !!OPENAI_KEY,
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

    const address   = String(body?.address ?? "").trim();
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = String(body?.list_text ?? "").trim();
    const mode      = String(body?.mode ?? "openai").toLowerCase(); // "openai" | "openai_web_only"

    const missing:string[]=[];
    if(!address) missing.push("address");
    if(!radius_km) missing.push("radius_km");
    if(!list_text) missing.push("list_text");
    if(missing.length){
      const resp = { status:"need_input", needed:missing, requestId:id };
      info(id, "need_input", resp);
      return c.json(resp, 400);
    }

    if (mode === "openai_web_only") {
      const q = `מחירים ${list_text} ליד ${address} בקוטר ${radius_km} ק"מ`;
      const hits = await googleCseSearch(id, q);
      const llmInput = `
Address: ${address}
Radius: ${radius_km} km
List: ${list_text}

Search snippets:
${hits.map(h=>`- ${h.title}: ${h.snippet} (${h.link})`).join("\n")}
`.trim();
      const out = await callOpenAI(id, PROMPT_FREE, llmInput);
      info(id, "openai_web_only done");
      return c.json(out, 200);
    }

    // ChatGPT-only (פרומפט חופשי, ללא הגנות)
    const llmIn = `Address: ${address}\nRadius: ${radius_km} km\nList: ${list_text}\n`;
    const out = await callOpenAI(id, PROMPT_FREE, llmIn);
    info(id, "openai only done");
    return c.json(out, 200);

  }catch(e:any){
    err(id, "handler failed", e);
    return c.json({ status:"error", message: e?.message || String(e), requestId:id }, 500);
  }
});

// ===== Serve SPA from ./public =====
async function tryReadIndex(): Promise<string|null> {
  try {
    const html = await Deno.readTextFile("./public/index.html");
    return html;
  } catch {
    return null;
  }
}

app.get("/", async (c) => {
  const id = rid();
  const html = await tryReadIndex();
  if (html) {
    info(id, "Serving ./public/index.html");
    return c.newResponse(html, 200, { "content-type": "text/html; charset=utf-8" });
  }
  info(id, "No ./public/index.html found. Serving a small helper page.");
  return c.newResponse(FALLBACK_HTML, 200, { "content-type": "text/html; charset=utf-8" });
});

// SPA fallback (deep routes)
app.notFound(async (c) => {
  const html = await tryReadIndex();
  return c.newResponse(
    html ?? FALLBACK_HTML,
    200,
    { "content-type": "text/html; charset=utf-8" }
  );
});

Deno.serve(app.fetch);

// ===== Minimal helper page if no public/index.html =====
const FALLBACK_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CartCompare AI – Setup</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;background:#f5f9ff;color:#0d1321;margin:0;padding:24px} .box{max-width:680px;margin:0 auto;background:#fff;border-radius:12px;padding:16px;box-shadow:0 10px 30px rgba(15,50,90,.08)} code{background:#eef2f7;padding:2px 6px;border-radius:6px}</style>
<div class="box">
  <h2>CartCompare AI</h2>
  <p>כדי להציג את ה־UI, שים את הקובץ <code>public/index.html</code> בריפו. כרגע השרת רץ, אבל אין קובץ UI להגיש.</p>
  <p>בדוק גם את <code>/api/health</code> לוודא שמפתחות הסביבה מוגדרים.</p>
</div>
</html>`;
