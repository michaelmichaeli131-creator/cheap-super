// server_deno.ts
// Deno + Hono + OpenAI Responses API (web_search) — Structured Outputs via text.format.json_schema
//
// ENV:
// OPENAI_API_KEY=sk-...
// OPENAI_MODEL=gpt-5.1           // או o4-mini / gpt-4o-mini / gpt-5.1-mini
// DEBUG=false
//
// Run locally:
// DEBUG=true OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-5.1 deno run --allow-net --allow-env --allow-read server_deno.ts

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { serveStatic } from "npm:hono/serve-static";

const app = new Hono();

// ===== ENV =====
const OPENAI_KEY   = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-5.1";
const DEBUG = (Deno.env.get("DEBUG") || "false").toLowerCase() === "true";

// ===== Utils =====
const SAFE_DEBUG_MAX = 600;
function rid(){ return crypto.randomUUID(); }
function info(id:string, msg:string, extra?:unknown){ console.log(`[${id}] ${msg}`, extra ?? ""); }
function err (id:string, msg:string, extra?:unknown){ console.error(`[${id}] ERROR: ${msg}`, extra ?? ""); }
class HttpError extends Error { status:number; constructor(s:number,m:string){ super(m); this.status=s; } }

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
function cleanText(s: string, maxLen = 280): string {
  const out = normalizeSpaces(stripBidiControls(decodeHtmlEntities(s)));
  return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}

// ===== System Prompt =====
const PROMPT_SYSTEM = `
You are a price-comparison agent for Israeli groceries.

INPUTS PROVIDED:
- address (city/street/country)
- radius_km (numeric)
- list_text (free-form shopping list)

TOOLS AVAILABLE:
- web_search: use it to find current, real prices from real Israeli stores.
  Prefer product/store pages over blogs/news.

TASK:
1) Parse list_text into concrete items (name, quantity, brand if known, size when obvious).
2) Use web_search to find realistic prices for those items (₪). Include product_url & source_domain for each line if available.
3) Return 3–4 stores near the given address within the radius. If distance is unknown, estimate (in km).
4) Sort stores by total_price ascending (cheapest → expensive).
5) If a price is not explicitly found, estimate reasonably, set lower match_confidence (e.g., 0.4), and add "notes".

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
          "match_confidence": 0.0,
          "substitution": false,
          "notes": "optional"
        }
      ],
      "match_overall": 0.0
    }
  ]
}

HARD RULES:
- Currency symbol must be "₪" for Israel.
- No zeros unless page explicitly shows 0.
- Absolutely NO TEXT OUTSIDE JSON.
- Ignore code repositories / developer docs / blogs (GitHub/Gist/NPM/etc.).
- Focus ONLY on Israeli retail product/store pages with explicit prices (rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il, etc.).
- If a page is mostly code or technical text, do not use it as a source.
`.trim();

// ===== OpenAI Responses API call =====
async function callOpenAIResponses(systemPrompt: string, userPrompt: string, id: string){
  if (!OPENAI_KEY) throw new HttpError(500, "Missing OPENAI_API_KEY");

  const schema = {
    name: "cart_compare_results",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "results"],
      properties: {
        status: { type: "string", enum: ["ok"] },
        results: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["rank","store_name","address","distance_km","currency","total_price","basket","match_overall"],
            properties: {
              rank: { type: "integer" },
              store_name: { type: "string" },
              address: { type: "string" },
              distance_km: { type: "number" },
              currency: { type: "string" },
              total_price: { type: "number" },
              notes: { type: "string" },
              basket: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name","brand","quantity","unit_price","line_total","product_url","source_domain","match_confidence","substitution"],
                  properties: {
                    name: { type: "string" },
                    brand: { type: "string" },
                    quantity: { type: "number" },
                    unit_price: { type: "number" },
                    line_total: { type: "number" },
                    product_url: { type: "string" },
                    source_domain: { type: "string" },
                    match_confidence: { type: "number" },
                    substitution: { type: "boolean" },
                    notes: { type: "string" }
                  }
                }
              },
              match_overall: { type: "number" }
            }
          }
        }
      }
    }
  } as const;

  const body = {
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: userPrompt,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    max_output_tokens: 1800,
    temperature: 0.2,

    // ✅ הצורה התקינה ב-Responses API
    text: {
      format: {
        type: "json_schema",
        json_schema: schema
      }
    }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }).catch((e)=> { throw new HttpError(502, `OpenAI fetch error: ${e?.message || String(e)}`); });

  const json = await resp.json().catch(()=> ({}));
  if (!resp.ok) {
    err(id, "OpenAI bad status", json);
    throw new HttpError(resp.status, `OpenAI ${resp.status}: ${JSON.stringify(json)}`);
  }

  // עם Structured Outputs נקבל output_parsed
  const parsed = (json.output_parsed ?? null);
  if (parsed && parsed.status === "ok" && Array.isArray(parsed.results)) {
    return { parsed, raw: json, output_text: undefined };
  }

  // fallback: ננסה לפענח טקסט חופשי אם יש (לא מחזירים במלואו ללקוח)
  const textOut =
    (typeof json.output_text === "string" && json.output_text) ||
    (Array.isArray(json.output) ? json.output.map((p:any)=> (typeof p?.content === "string" ? p.content : "")).join("\n") : "") ||
    "";
  const tryParsed = extractJson(String(textOut));
  return { parsed: tryParsed, raw: json, output_text: textOut };
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

// דיבוג פרומפט (לא מריץ מודל)
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

SEARCH SCOPE:
- Use web_search only on Israeli retailer domains (rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il).
- Ignore GitHub/Gist/NPM/docs/blogs.

NOTE: Return STRICT JSON only (see schema in system instructions).`;

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
- Use web_search to collect real prices (₪) from Israeli retailers near the address.
- Prefer product/store pages; include product_url and source_domain for each basket line when available.
- If price not explicit, estimate (lower confidence) and add notes.
- Return STRICT JSON only (see schema in system instructions).

SEARCH SCOPE:
- Allowed retailer domains (not exhaustive): rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il.
- Ignore code repositories, developer docs/blogs and technical pages.`;

    const { parsed, raw, output_text } = await callOpenAIResponses(PROMPT_SYSTEM, userPrompt, id);

    if (!parsed || parsed.status !== "ok" || !Array.isArray(parsed.results)) {
      const safeText = typeof output_text === "string" ? output_text.slice(0, SAFE_DEBUG_MAX) : undefined;
      return c.json({
        status: "no_results",
        message: "Model did not return expected JSON shape",
        results: [],
        debug: DEBUG ? { output_text: safeText, has_more: (safeText && output_text && (output_text.length>SAFE_DEBUG_MAX)) || false } : undefined,
        requestId: id
      }, 502);
    }

    const payload:any = { ...parsed, requestId:id };
    if (DEBUG || body?.include_debug) payload.debug = { openai_raw: raw };
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
