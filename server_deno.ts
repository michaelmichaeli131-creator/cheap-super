// server_deno.ts
// Deno + Hono + OpenAI Responses API (web_search) — Structured Outputs (json_schema) + full error debug
//
// ENV (set before run):
//   OPENAI_API_KEY=sk-...            (required)
//   OPENAI_MODEL=gpt-4.1             (recommended stable model with web_search)
//   DEBUG=false                      (true for extra debug)
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

INPUTS PROVIDED:
- address (city/street/country)
- radius_km (numeric)
- list_text (free-form shopping list)

TOOLS AVAILABLE:
- web_search: use it to find current, real prices from real Israeli stores (retailer/product pages).
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
- Focus ONLY on Israeli retail product/store pages with explicit prices (e.g., rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il).
`.trim();

// ===== OpenAI Responses API call (Structured Outputs + full error capture) =====
async function callOpenAIResponses(systemPrompt: string, userPrompt: string, id: string){
  if (!OPENAI_KEY) throw new HttpError(500, "Missing OPENAI_API_KEY");

  // Relaxed strict JSON Schema: allow empty arrays, make "notes" optional
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "results"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "rank",
            "store_name",
            "address",
            "distance_km",
            "currency",
            "total_price",
            "basket",
            "match_overall"
          ],
          properties: {
            rank: { type: "integer" },
            store_name: { type: "string" },
            address: { type: "string" },
            distance_km: { type: "number" },
            currency: { type: "string" },
            total_price: { type: "number" },
            notes: { type: ["string","null"] },
            basket: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "name",
                  "brand",
                  "quantity",
                  "unit_price",
                  "line_total",
                  "product_url",
                  "source_domain",
                  "match_confidence",
                  "substitution"
                ],
                properties: {
                  name: { type: "string" },
                  brand: { type: ["string","null"] },
                  quantity: { type: "number" },
                  unit_price: { type: "number" },
                  line_total: { type: "number" },
                  product_url: { type: "string" },
                  source_domain: { type: "string" },
                  match_confidence: { type: "number", minimum: 0, maximum: 1 },
                  substitution: { type: "boolean" },
                  notes: { type: ["string","null"] }
                }
              }
            },
            match_overall: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  } as const;

  const body: any = {
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: userPrompt,
    // Built-in web search tool
    tools: [{ type: "web_search" }],
    // Force using the tool (since it's the only one, it will be web_search)
    tool_choice: "required",
    // no temperature (some models don’t support it)
    max_output_tokens: 1800,
    text: {
      format: {
        type: "json_schema",
        name: "cart_compare_results",
        schema
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

  // With Structured Outputs we expect output_parsed
  const parsed = (jsonOrText?.output_parsed ?? null);
  if (parsed && parsed.status === "ok" && Array.isArray(parsed.results)) {
    return { parsed, raw: jsonOrText, request_id: requestIdHeader };
  }

  // Fallback: try to extract JSON from textual output (rare, but helpful in debugging)
  const outputText =
    (typeof jsonOrText?.output_text === "string" && jsonOrText.output_text) ||
    (Array.isArray(jsonOrText?.output) ? jsonOrText.output.map((p:any)=> (typeof p?.content === "string" ? p.content : "")).join("\n") : "") ||
    "";
  const tryParsed = extractJson(outputText);
  if (!tryParsed) {
    throw new HttpError(400, "Model did not return expected JSON shape (no output_parsed)", {
      output_text_excerpt: outputText ? outputText.slice(0, SAFE_DEBUG_MAX) : "",
      raw_excerpt: JSON.stringify(jsonOrText ?? "").slice(0, SAFE_DEBUG_MAX),
      x_request_id: requestIdHeader
    });
  }
  return { parsed: tryParsed, raw: jsonOrText, request_id: requestIdHeader };
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

// Preview prompts without calling the model (DEBUG only)
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
- Only Israeli retailer/product pages with explicit prices.
- Prefer store pages; ignore blogs/docs/dev sites.

If you cannot find any valid store/product prices, RETURN: {"status":"ok","results":[]}
Return STRICT JSON (see system schema).`;

  return c.json({
    status:"ok",
    debug:{ instructions: PROMPT_SYSTEM, user_input: userPrompt },
    requestId: id
  });
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
- Include product_url and source_domain for each line when available.
- If a price is missing, estimate with lower confidence and add notes.
- If you cannot find any valid store/product prices, RETURN: {"status":"ok","results":[]}
- Return STRICT JSON only (see schema in system).`;

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
