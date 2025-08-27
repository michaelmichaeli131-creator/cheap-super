// server_deno.ts
// Deno + Hono + OpenAI Responses API (web_search) — function tool + temperature: 0 + debug
//
// ENV (before run):
//   OPENAI_API_KEY=sk-...
//   OPENAI_MODEL=gpt-4.1       // מומלץ; אפשר גם gpt-4o/gpt-4.1-mini וכו'
//   DEBUG=false                 // true לדיבוג מורחב
//
// Run (local):
//   DEBUG=true OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4.1 deno run --allow-net --allow-env --allow-read server_deno.ts

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";

// ===== Utils =====
const SAFE_DEBUG_MAX = 2000;
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

// ===== System Prompt =====
const PROMPT_SYSTEM = `
You are a price-comparison agent for Israeli groceries.

HARD POLICY (DO NOT VIOLATE):
- Do NOT fabricate prices or branches. Use ONLY information found on the public web during this call.
- Every price MUST have a supporting product page URL showing "₪" or an explicit structured price. If missing, either (a) mark substitution=true with notes and low match_confidence, or (b) DROP the line.
- Branches must be REAL branches. Include branch_name/address and a branch_url that is either a branch page or the chain’s official store-locator page for the correct city.
- Use ONLY official Israeli retailer domains or reputable local price comparison sites with explicit prices (e.g., rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il).
- If an exact pack/size is unavailable, return the closest substitute and set substitution=true; compute price-per-unit (ppu) and explain in notes.

TOOLS:
- web_search: use bilingual (Heb/Eng) focused queries with brand + size + pack ("שישייה","6×1.5","6x1.5L") and the "₪" symbol; apply site filters for the chain.

OUTPUT:
- You MUST finish by calling the function tool \`submit_results\` ONCE with strict JSON. No free text.
`.trim();

// ===== Function Tool Schema (submit_results) =====
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
          "rank","store_name","branch_name","address","branch_url",
          "distance_km","currency","total_price","coverage","notes",
          "basket","match_overall"
        ],
        properties: {
          rank: { type:"integer" },
          store_name: { type:"string" },
          branch_name: { type:"string" },
          address: { type:"string" },
          branch_url: { type:"string" },
          distance_km: { type:"number" },
          currency: { type:"string" },               // "₪"
          total_price: { type:"number" },
          coverage: { type:"number", minimum:0, maximum:1 },
          notes: { type:["string","null"] },
          basket: {
            type: "array",
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
                ppu: { type:["number","null"] },      // price per unit (L/kg), if applicable
                line_total: { type:"number" },
                product_url: { type:"string" },
                source_domain: { type:"string" },
                source_title: { type:["string","null"] },
                observed_price_text: { type:["string","null"] },
                observed_at: { type:["string","null"] }, // ISO time
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

// ===== OpenAI Responses API call (web_search + function tool) =====
async function callOpenAIResponses(systemPrompt: string, userPrompt: string, id: string){
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
    tool_choice: "auto",       // נותנים למודל לבחור, אך הנחיות דורשות לסיים ב-submit_results
    temperature: 0,            // ✅ דטרמיניזם מקסימלי
    max_output_tokens: 2000
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }).catch((e)=> {
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

  // חיפוש קריאת פונקציה submit_results
  const outputArr = Array.isArray(jsonOrText?.output) ? jsonOrText.output : [];
  const fnCall = outputArr.find((p:any)=> p?.type==="function_call" && p?.name==="submit_results");
  if (!fnCall) {
    // fallback: לפעמים המודל שם JSON בטקסט
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
  try {
    // ב-Responses API, arguments הוא מחרוזת JSON
    parsed = typeof fnCall.arguments === "string" ? JSON.parse(fnCall.arguments) : fnCall.arguments;
  } catch (e:any) {
    throw new HttpError(400, "Failed to parse submit_results.arguments", {
      arguments_excerpt: String(fnCall?.arguments ?? "").slice(0, SAFE_DEBUG_MAX),
      x_request_id: requestIdHeader
    });
  }

  return { parsed, raw: jsonOrText, request_id: requestIdHeader };
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
    has_openai_key: !!OPENAI_KEY,
    debug_enabled: DEBUG,
    requestId: id
  };
  info(id, "GET /api/health", payload);
  return c.json(payload);
});

// תצוגת הפרומפטים ללא הרצה (DEBUG בלבד)
app.get("/api/llm_preview", async (c)=>{
  if (!DEBUG) return c.json({ status:"forbidden", message:"Enable DEBUG=true to use /api/llm_preview" }, 403);
  const id = rid();
  const address = cleanText(c.req.query("address") || "");
  const radius_km = Number(c.req.query("radius_km") || "5");
  const list_text = cleanText(c.req.query("list_text") || "");
  if (!address || !list_text){
    return c.json({ status:"need_input", needed:["address","list_text"], requestId:id }, 400);
  }

  const userPrompt =
`address: ${address}
radius_km: ${radius_km}
list_text: ${list_text}

ENFORCEMENTS:
- Approved Israeli retailers only. Real branches for the given city.
- Prices must show ₪ on the page; otherwise substitution=true with low confidence or drop.
- For substitutes, compute ppu and explain in notes.

Finish by calling submit_results (no free text).`;

  return c.json({
    status:"ok",
    debug:{ instructions: PROMPT_SYSTEM, user_input: userPrompt },
    requestId: id
  });
});

// חיפוש ראשי
app.post("/api/search", async (c)=>{
  const id = rid();
  try{
    const body = await c.req.json().catch(()=> ({}));
    info(id, "POST /api/search body", body);

    const address   = cleanText(String(body?.address ?? "").trim());
    const radius_km = Number(body?.radius_km ?? 0);
    const list_text = cleanText(String(body?.list_text ?? "").trim());

    const miss:string[]=[];
    if(!address)   miss.push("address");
    if(!radius_km) miss.push("radius_km");
    if(!list_text) miss.push("list_text");
    if (miss.length){
      return c.json({ status:"need_input", needed: miss, requestId:id }, 400);
    }

    const userPrompt =
`address: ${address}
radius_km: ${radius_km}
list_text: ${list_text}

INSTRUCTIONS:
- Use web_search to collect live prices (₪) from official Israeli retailers near the address.
- Include product_url/source_domain/source_title and observed_price_text with "₪".
- Real branch only: branch_name/address/branch_url must match the city near "${address}".
- If exact pack missing, return closest substitute with substitution=true, ppu, and notes.

Return ONE function call (submit_results). No free text.`;

    const { parsed, raw, request_id } = await callOpenAIResponses(PROMPT_SYSTEM, userPrompt, id);
    const payload:any = { ...parsed, requestId:id, openai_request_id: request_id ?? undefined };
    if (DEBUG || body?.include_debug) payload.debug = { openai_raw_excerpt: JSON.stringify(raw).slice(0, SAFE_DEBUG_MAX) };
    return c.json(payload, 200);

  }catch(e:any){
    const status = typeof e?.status === "number" ? e.status : 500;
    const message = e?.message || String(e);
    const payload:any = { status:"error", message, requestId:id };
    if (e?.payload) payload.details = e.payload; // error/full_response/x_request_id
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
