/// <reference no-default-lib="true"/>
import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/serve-static"; // ← זה הנכון לגרסה 4.9.2
import OpenAI from "@openai/openai";


// קריאת סודות מהסביבה של Deno Deploy
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY! });

const SYSTEM_PROMPT = `
You are an autonomous, tool-using price-comparison agent for groceries in Israel.

Objective
- Collect user's address or city, shopping list (name + optional quantity), and search radius (km).
- Using ONLY your own tools (web browsing, code execution, file I/O) and public "Price Transparency" feeds
  from Israeli retailers, you must:
  1) Geocode the address/city to lat/lng.
  2) Discover and download the official retailer transparency files (stores, prices, promotions).
  3) Parse them (XML/JSON/CSV/GZ).
  4) Filter branches within the given radius (km) from the user.
  5) Normalize/resolve the shopping list to SKUs (prefer GTIN/EAN; else robust text matching).
  6) Compute the basket total per branch deterministically from the transparency files.
  7) Sort ascending by total_price; break ties by distance_km.
  8) Return ONLY strict JSON per the schemas below.

Non-negotiable Rules
- ALL data retrieval, parsing, matching, and math must be performed by you using your tools.
- NEVER fabricate prices, distances, or store data. If you cannot retrieve or parse feeds, return "no_results".
- If inputs are missing, return status="need_input" and list which fields are missing.
- Currency is ILS; distances in km with one decimal.
- For details of one branch, return the line-item breakdown you actually computed from the feeds.
- Output MUST be valid JSON and match the schemas exactly. No extra text.

Schemas
SearchResults:
{
  "type":"object",
  "properties":{
    "status":{"enum":["ok","no_results","need_input","error"]},
    "needed":{"type":"array","items":{"enum":["address","items","radius_km"]}},
    "results":{"type":"array","items":{
      "type":"object",
      "properties":{
        "rank":{"type":"integer"},
        "chain":{"type":"string"},
        "branch_name":{"type":"string"},
        "branch_id":{"type":"string"},
        "distance_km":{"type":"number"},
        "total_price":{"type":"number"},
        "currency":{"const":"ILS"}
      },
      "required":["rank","chain","branch_name","branch_id","distance_km","total_price","currency"]
    }}
  },
  "required":["status"]
}

BranchBreakdown:
{
  "type":"object",
  "properties":{
    "branch_id":{"type":"string"},
    "items":{"type":"array","items":{
      "type":"object",
      "properties":{
        "requested":{"type":"string"},
        "matched_sku":{"type":"string"},
        "unit_price":{"type":"number"},
        "qty":{"type":"number"},
        "line_total":{"type":"number"},
        "currency":{"const":"ILS"}
      },
      "required":["requested","matched_sku","unit_price","qty","line_total","currency"]
    }},
    "total_price":{"type":"number"},
    "currency":{"const":"ILS"}
  },
  "required":["branch_id","items","total_price","currency"]
}

Operational Guidance
- Geocoding: use a public API or a web lookup to get lat/lng for the provided address/city.
- Retailer data: use Israel’s "Price Transparency" endpoints on the retailers’ sites (XML/JSON, often .gz).
- Matching logic: prefer GTIN/EAN when present; otherwise combine brand, size, and product string similarity.
- Promotions: if a feed includes promotions in a structured way, apply them; otherwise compute regular prices only.
- If multiple candidate products match a requested item, choose the closest by size and brand; if ambiguous, omit that line and continue.
- Distance: use Haversine or equivalent; report with one decimal.
- Determinism: do not ask the user for approval mid-computation. Either compute and return "ok", or return "need_input"/"no_results"/"error" with minimal explanation in JSON fields only.
`.trim();

function buildSearchUserPrompt(address = "", radius_km: number | string = "", items: string[] = []) {
  const listBlock = items.map(s => s.trim()).filter(Boolean).join("\n");
  return `
Task: Compute the three cheapest supermarket branches within the given radius and return SearchResults JSON.

Address/City: ${address}
Radius_km: ${radius_km}
Shopping list (one per line; optional quantity with ';qty'):
${listBlock}
`.trim();
}

function buildDetailsUserPrompt(branch_id: string) {
  return `
Task: Show itemized breakdown for the computed basket at this branch and return BranchBreakdown JSON.

branch_id=${branch_id}
`.trim();
}

// קריאה ל-Responses API עם כלי web+code (המודל תומך בהם)
async function callLLM(userPrompt: string) {
  const resp = await client.responses.create({
    model: OPENAI_MODEL,
    system: SYSTEM_PROMPT,
    input: userPrompt,
    tools: [
      { type: "web_search" },
      { type: "code_interpreter" }
    ]
  });

  // חילוץ טקסט
  const text = (resp as any).output_text ??
    (Array.isArray((resp as any).output)
      ? (resp as any).output.map((o: any) => {
          if (Array.isArray(o.content)) {
            return o.content.map((c: any) => c.text || "").join("\n");
          }
          return "";
        }).join("\n")
      : JSON.stringify(resp));

  // ולידציית JSON
  try {
    return JSON.parse(String(text).trim());
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return { status: "error", message: "Model did not return valid JSON", raw: text };
  }
}

const app = new Hono();

// סטטי (UI)
app.use("/", serveStatic({ root: "./public" }));

// API – חיפוש TOP-3
app.post("/api/search", async c => {
  const body = await c.req.json().catch(() => ({}));
  const { address = "", radius_km = "", items = [] } = body ?? {};
  const userPrompt = buildSearchUserPrompt(address, radius_km, items);
  const out = await callLLM(userPrompt);
  return c.json(out);
});

// API – פירוט סניף
app.post("/api/details", async c => {
  const body = await c.req.json().catch(() => ({}));
  const { branch_id = "" } = body ?? {};
  const userPrompt = buildDetailsUserPrompt(branch_id);
  const out = await callLLM(userPrompt);
  return c.json(out);
});

// Deno Deploy: מייצאים handler של fetch
export default {
  fetch: app.fetch,
};
