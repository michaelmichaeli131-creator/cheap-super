// server_deno.ts — Deno Deploy: static via serveDir, API via Hono
import { serveDir } from "jsr:@std/http/file-server";
import { Hono } from "jsr:@hono/hono";
import { OpenAI } from "jsr:@openai/openai";

type ShoppingItem = { name: string; quantity: number };
type SearchRequest = { address?: string; radius_km?: number; shopping_list?: ShoppingItem[] };

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set. Set it in Deno Deploy → Project → Settings → Environment Variables.");
}
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

const client = new OpenAI({ apiKey: OPENAI_API_KEY ?? "" });
const app = new Hono();

// ---------- API ----------
app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/api/search", async (c) => {
  let body: SearchRequest;
  try {
    body = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ status: "error", message: "Invalid JSON body" }, 400);
  }

  const needed: string[] = [];
  if (!body.address?.trim()) needed.push("address");
  if (!Number.isFinite(Number(body.radius_km))) needed.push("radius_km");
  if (!Array.isArray(body.shopping_list) || body.shopping_list.length === 0) needed.push("shopping_list");
  if (needed.length) return c.json({ status: "need_input", needed }, 400);

  try {
    const results = await createSearchResults(body);
    return c.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/search] error:", message);
    return c.json({ status: "error", message }, 500);
  }
});

async function createSearchResults(req: SearchRequest) {
  const instructions = `
אתה מסייע בבניית השוואת מחירים לסל קניות בסופרמרקטים בישראל.
החזר JSON בלבד לפי הסכמה:
- status: "ok" | "no_results" | "need_input" | "error"
- needed: string[] (אם need_input)
- results: [{ rank, store_name, address, distance_km, currency, total_price, basket:[{name,quantity,unit_price,line_total}] }]
הקפד: line_total = unit_price * quantity; וסכום ה-line_total = total_price. אם אין מספיק מידע — no_results.
אל תוסיף שדות מעבר לסכמה.
`.trim();

  const payload = {
    address: req.address,
    radius_km: req.radius_km,
    shopping_list: req.shopping_list,
  };

  const response = await client.responses.create({
    model: MODEL,
    instructions,
    input: JSON.stringify(payload), // מחרוזת פשוטה
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "SearchResults",
        strict: true,
        schema: {
          type: "object",
          properties: {
            status: { enum: ["ok", "no_results", "need_input", "error"] },
            needed: { type: "array", items: { type: "string" } },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  store_name: { type: "string" },
                  address: { type: "string" },
                  distance_km: { type: "number" },
                  currency: { type: "string" },
                  total_price: { type: "number" },
                  basket: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        quantity: { type: "number" },
                        unit_price: { type: "number" },
                        line_total: { type: "number" }
                      },
                      required: ["name", "quantity", "unit_price", "line_total"],
                      additionalProperties: false
                    }
                  }
                },
                required: ["rank","store_name","address","distance_km","currency","total_price","basket"],
                additionalProperties: false
              }
            }
          },
          required: ["status"],
          additionalProperties: false
        }
      }
    },
    temperature: 0.2,
    max_output_tokens: 1200
  });

  const textCandidate =
    (response as any).output_text ??
    ((response as any).output?.[0]?.content?.[0]?.type === "output_text"
      ? (response as any).output[0].content[0].text
      : undefined);
  if (!textCandidate) throw new Error("LLM returned no text output");

  let parsed: any;
  try { parsed = JSON.parse(textCandidate); }
  catch {
    console.error("Model output (not JSON):", textCandidate);
    throw new Error("Failed to parse model JSON");
  }

  if (parsed.status === "ok" && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (Array.isArray(r.basket)) {
        r.total_price = r.basket.reduce((acc: number, l: any) => acc + Number(l.line_total ?? 0), 0);
      }
    }
  }
  return parsed;
}

// ---------- HTTP entry (static + API) ----------
Deno.serve((req) => {
  const url = new URL(req.url);

  // API goes to Hono app
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    return app.fetch(req);
  }

  // Everything else: serve ./public with index.html as default
  return serveDir(req, { fsRoot: "public", urlRoot: "", index: "index.html" });
});
