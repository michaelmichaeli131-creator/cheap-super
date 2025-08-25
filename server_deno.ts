// server_deno.ts
// Hono via npm (avoids deno.land version 404), OpenAI, Google CSE
// Modes:
//   - openai           → ChatGPT רגיל (פרומפט חופשי, ללא הגנות)
//   - openai_web_only  → ChatGPT עם חיפוש ברשת בלבד (Google CSE), עדיין פרומפט חופשי
//
// Env (Deno Deploy → Settings → Environment Variables):
// OPENAI_API_KEY=sk-...
// OPENAI_MODEL=gpt-4o-mini   // או כל מודל שיש לך (gpt-4o/gpt-5 אם פתוח)
// GOOGLE_CSE_KEY=AIza...
// GOOGLE_CSE_CX=758dd387a6efa4bfe
// DEBUG=true                 // אופציונלי

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY") ?? "";
const GOOGLE_CSE_CX  = Deno.env.get("GOOGLE_CSE_CX")  ?? "";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase()==="true";

function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }

// ===== PROMPT (ChatGPT-only, חופשי) =====
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

// ===== Middlewares =====
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET","POST","OPTIONS"],
  allowHeaders: ["Content-Type","Authorization"],
}));

// ===== Helpers =====
type ChatMsg = { role:"system"|"user"; content:string };

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
  if (DEBUG) info(id, "OpenAI req", { model: OPENAI_MODEL });

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
  if (DEBUG) info(id, "OpenAI resp", { hasChoices: !!j.choices?.length });
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI empty content");

  try {
    return JSON.parse(text);
  } catch (e) {
    // מחזיר עטיפה אם זה לא JSON
    err(id, "OpenAI returned non-JSON, wrapping", text);
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

  if (DEBUG) info(id, "CSE url", url.toString());

  const res = await fetch(url.toString());
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) {
    err(id, "CSE bad status", data);
    throw new Error(`CSE ${res.status}: ${JSON.stringify(data)}`);
  }
  if (DEBUG) info(id, "CSE items", (data.items||[]).length);
  return (data.items||[]).map((it:any)=>({
    title: String(it.title||""),
    link:  String(it.link||""),
    snippet:String(it.snippet||"")
  }));
}

function extractJsonBlock(s:string){
  const a=s.indexOf("{"), b=s.lastIndexOf("}");
  return (a>=0 && b>a) ? s.slice(a,b+1) : s.trim();
}

// ===== Routes =====
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
      // 1) Google CSE
      const q = `מחירים ${list_text} ליד ${address} בקוטר ${radius_km} ק"מ`;
      const hits = await googleCseSearch(id, q);

      // 2) הזרקת הסניפטים ל-LLM (עדיין חופשי — לא “מענישים” על חוסר/0)
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

    // Default: openai only (פרומפט חופשי, ללא הגנות)
    const llmIn = `Address: ${address}\nRadius: ${radius_km} km\nList: ${list_text}\n`;
    const out = await callOpenAI(id, PROMPT_FREE, llmIn);
    info(id, "openai only done");
    return c.json(out, 200);

  }catch(e:any){
    err(id, "handler failed", e);
    return c.json({ status:"error", message: e?.message || String(e), requestId:id }, 500);
  }
});

// Root
app.get("/", (c)=> c.text("CartCompare AI server is running ✅"));

Deno.serve(app.fetch);
