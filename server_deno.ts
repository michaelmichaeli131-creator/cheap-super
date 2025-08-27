// server_deno.ts
// Deno + Hono + OpenAI Responses API (web_search) — GPT-4.1 + Function Calling + “evidence-only” policy
//
// ENV (before run):
//   OPENAI_API_KEY=sk-...            (required)
//   OPENAI_MODEL=gpt-4.1             (stable model with web_search)
//   DEBUG=false                      (true for extra debug)
//
// Run locally:
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

// ===== System Prompt (STRICT “evidence-only”) =====
const PROMPT_SYSTEM = `
You are a price-comparison agent for Israeli groceries.

HARD POLICY (DO NOT VIOLATE):
- DO NOT FABRICATE prices or branches. Use ONLY information found on the public web during this call.
- Retailer sources must be official Israeli chains (e.g., rami-levy.co.il, shufersal.co.il, victoryonline.co.il, yohananof.co.il, tivtaam.co.il, osherad.co.il), or reputable comparison sites that show explicit prices.
- Every price you return MUST have a supporting product URL with "₪" or a structured price captured in the page. If not present, treat as estimate with low confidence and add notes.
- Branches must be REAL branches. Include branch name and address as shown online, and prefer a branch product page or store locator URL for that specific branch/city. If uncertain, do not invent—downgrade confidence or exclude the store.

INPUTS PROVIDED:
- address (city/street/country)
- radius_km (numeric)
- list_text (free-form shopping list)

TOOLS:
- web_search: use for live data. Issue focused bilingual queries (Heb/Eng) with brand + size + pack. Use site filters and synonyms:
  Examples:
    "מי עדן 6×1.5 ליטר מחיר site:rami-levy.co.il ₪"
    "Mei Eden 6x1.5 price site:victoryonline.co.il ₪"
    Include: "שישייה", "אריזת 6", "6*1.5", "6x1.5L".
  If barcode/GTIN appears in snippets, search it too.

TASK:
1) Parse list_text into concrete items (name, quantity, brand if known, size).
2) For each item, find pack_qty and size. If the exact pack isn't available, find the closest substitute (e.g., 12×0.5L instead of 6×1.5L), mark substitution=true, compute ppu (price per unit: L/kg), and explain in notes.
3) For each basket line include: product_url, source_domain, source_title, observed_price_text (short), observed_at (ISO), in_stock (boolean), size, pack_qty, unit, unit_price, ppu, line_total, match_confidence, substitution, notes.
4) Return 3–4 **real branches** near the given address within the radius. For each store include branch name and address from the web (or store-locator URL). If distance_km unknown, estimate.
5) Rank stores by total_price ascending. Also include "coverage" = share of basket lines with non-estimated prices.
6) Currency must be "₪". No zeros unless the page shows 0.

OUTPUT:
- Return exactly ONE function call to submit_results with strict JSON. No free text.
- If you cannot find reliable prices, return {"status":"ok","results":[]} with notes per store explaining why.
`.trim();

// ===== OpenAI Responses API (Function Calling + web_search) =====
async function callOpenAIResponses(systemPrompt: string, userPrompt: string, id: string){
  if (!OPENAI_KEY) throw new HttpError(500, "Missing OPENAI_API_KEY");

  // Function tool schema — requires evidence and real branches
  const submitResultsFunction = {
    type: "function",
    name: "submit_results",
    description: "Return the final price comparison JSON. Call exactly once at the end.",
    parameters: {
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
              "rank","store_name","branch_name","address","branch_url",
              "distance_km","currency","total_price","coverage",
              "basket","match_overall","notes"
            ],
            properties: {
              rank: { type: "integer" },
              store_name: { type: "string" },
              branch_name: { type: "string" },      // e.g., "שופרסל דיל — חולון, סוקולוב"
              address: { type: "string" },          // branch address as shown online
              branch_url: { type: ["string","null"] }, // store locator or branch page
              distance_km: { type: "number" },
              currency: { type: "string" },
              total_price: { type: "number" },
              coverage: { type: "number", minimum: 0, maximum: 1 },
              notes: { type: ["string","null"] },
              basket: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "name","brand","quantity",
                    "size","pack_qty","unit",
                    "unit_price","ppu","line_total",
                    "product_url","source_domain","source_title",
                    "observed_price_text","observed_at","in_stock",
                    "match_confidence","substitution","notes"
                  ],
                  properties: {
                    name: { type: "string" },
                    brand: { type: ["string","null"] },
                    quantity: { type: "number" },
                    size: { type: ["string","null"] },       // e.g., "1.5L"
                    pack_qty: { type: ["number","null"] },   // e.g., 6
                    unit: { type: ["string","null"] },       // "L","kg","g","ml"
                    unit_price: { type: "number" },          // price for one pack or one unit as presented on page
                    ppu: { type: ["number","null"] },        // price per liter/kg if derivable
                    line_total: { type: "number" },
                    product_url: { type: "string" },
                    source_domain: { type: "string" },
                    source_title: { type: ["string","null"] },
                    observed_price_text: { type: ["string","null"] },
                    observed_at: { type: ["string","null"] }, // ISO datetime
                    in_stock: { type: "boolean" },
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
    }
  } as const;

  const body: any = {
    model: OPENAI_MODEL,                             // gpt-4.1
    instructions: systemPrompt,
    input: userPrompt,
    tools: [
      { type: "web_search" },                        // built-in web search (see docs)
      submitResultsFunction
    ],
    // Force the model to return ONLY the function output:
    // (Responses API tool-choice format)
    tool_choice: { type: "function", name: "submit_results" },
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

  let json:any = null;
  try { json = await resp.json(); }
  catch {
    const txt = await resp.text().catch(()=>null);
    throw new HttpError(502, "OpenAI non-JSON response", { text_excerpt: txt?.slice(0, SAFE_DEBUG_MAX), x_request_id: requestIdHeader });
  }

  if (!resp.ok) {
    throw new HttpError(resp.status, `OpenAI ${resp.status}`, {
      error: (json?.error ?? null),
      full_response: json ?? null,
      x_request_id: requestIdHeader
    });
  }

  if (DEBUG) {
    info(id, "OpenAI outputs (types)", Array.isArray(json?.output) ? json.output.map((p:any)=>p?.type) : json?.output);
  }

  // Parse function/tool call (supports both shapes)
  const outputs = Array.isArray(json?.output) ? json.output : [];

  let candidate = outputs.find((p:any)=>
    (p?.type === "function_call" && (p?.name === "submit_results" || p?.function?.name === "submit_results")) ||
    (p?.type === "tool_call"     && (p?.tool === "submit_results" || p?.function?.name === "submit_results"))
  );
  if (!candidate) {
    const calls = outputs.filter((p:any)=> p?.type === "function_call" || p?.type === "tool_call");
    if (calls.length === 1) candidate = calls[0];
  }

  let argsStr: string | null = null;
  if (candidate) {
    if (typeof candidate?.arguments === "string") argsStr = candidate.arguments;
    if (!argsStr && typeof candidate?.function?.arguments === "string") argsStr = candidate.function.arguments;
  }

  if (!argsStr) {
    const outputText = typeof json?.output_text === "string" ? json.output_text : "";
    const tryParsed = extractJson(outputText);
    if (!tryParsed) {
      throw new HttpError(400, "Model did not return a submit_results tool/function call", {
        output_text_excerpt: outputText.slice(0, SAFE_DEBUG_MAX),
        raw_excerpt: JSON.stringify(json).slice(0, SAFE_DEBUG_MAX),
        x_request_id: requestIdHeader
      });
    }
    return { parsed: tryParsed, raw: json, request_id: requestIdHeader };
  }

  try {
    const parsed = JSON.parse(argsStr);
    return { parsed, raw: json, request_id: requestIdHeader };
  } catch {
    throw new HttpError(400, "submit_results.arguments is not valid JSON", {
      arguments_excerpt: String(argsStr).slice(0, SAFE_DEBUG_MAX),
      raw_excerpt: JSON.stringify(json).slice(0, SAFE_DEBUG_MAX),
      x_request_id: requestIdHeader
    });
  }
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

INSTRUCTIONS (recap):
- Use web_search with bilingual queries (Heb/Eng), pack synonyms, and site filters for Israeli retailers.
- Evidence only: every price must have a product URL with ₪ or structured price; otherwise estimate with notes & low confidence.
- Return ONE function call (submit_results) with strict JSON only.`;

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
- Use web_search to collect **real** prices (₪) from Israeli retailer product pages or reputable price-comparison sites ONLY.
- Do NOT invent prices or branches. Include branch_name, address, and branch_url (locator or branch/product page).
- For each line: include product_url, source_domain, source_title, observed_price_text, observed_at (ISO), in_stock.
- If exact pack not found, return best substitute with substitution=true and compute ppu; explain in notes.
- Rank by total_price; include coverage.
- Return ONE function call to submit_results with strict JSON.`;

    const { parsed, raw, request_id } = await callOpenAIResponses(PROMPT_SYSTEM, userPrompt, id);
    const payload:any = { ...parsed, requestId:id, openai_request_id: request_id ?? undefined };
    if (DEBUG || body?.include_debug) payload.debug = { openai_raw_excerpt: JSON.stringify(raw).slice(0, SAFE_DEBUG_MAX) };
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
