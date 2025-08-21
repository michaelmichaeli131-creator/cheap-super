// server_deno.ts — Deno Deploy friendly
// App: השוואת סל קניות בסופרמרקטים
// Framework: Hono
// OpenAI Responses API with strict JSON schema

import { Hono } from "@hono/hono";
import { OpenAI } from "@openai/openai";

type ShoppingItem = { name: string; quantity: number };
type SearchRequest = {
  address?: string;
  radius_km?: number;
  shopping_list?: ShoppingItem[];
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set (Deploy: add it in Project → Settings → Environment Variables).");
}
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

const client = new OpenAI({ apiKey: OPENAI_API_KEY ?? "" });
const app = new Hono();

// ---- Serve the UI (Super index.html) ----
// In Deno Deploy, read bundled file via URL relative to this module.
app.get("/", async (c) => {
  try {
    const htmlUrl = new URL("./Super index.html", import.meta.url);
    const html = await Deno.readTextFile(htmlUrl);
    return c.html(html);
  } catch (_e) {
    return c.text("Super index.html not found in bundle.", 500);
  }
});

// Healthcheck
app.get("/healthz", (c) => c.json({ ok: true }));

// ---- API: /api/search ----
app.post("/api/search", async (c) => {
  let body: SearchRequest;
  try {
    body = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ status: "error", message: "Invalid JSON body" }, 400);
  }

  const needed: string[] = [];
  if (!body.address || body.address.trim().length === 0) needed.push("address");
  if (!Number.isFinite(Number(body.radius_km))) needed.push("radius_km");
  if (!Array.isArray(body.shopping_list) || body.shopping_list.length === 0) needed.push("shopping_list");

  if (needed.length > 0) {
    return c.json({ status: "need_input", needed }, 400);
  }

  try {
    const results = await createSearchResults(body);
    return c.json(results);
  } catch (err) {
    console.error("[/api/search] error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", message }, 500);
  }
});

// ---- OpenAI call ----
async function createSearchResults(req: SearchRequest) {
  const instructions = `
אתה מסייע בבניית השוואת מחירים לסל קניות בסופרמרקטים בישראל.
קבל כתובת/עיר, רדיוס בק"מ ורשימת מוצרים (שם + כמות).
החזר JSON בלבד לפי הסכמה שניתנת עם שדות:
- status: "ok" | "no_results" | "need_input" | "error"
- needed: רשימת שדות חסרים (אם need_input)
- results: מערך של חנויות כאשר לכל חנות:
  rank (מספר),
  store_name (string),
  address (string),
  distance_km (מספר),
  currency (string, לדוגמה "₪"),
  total_price (מספר),
  basket: מערך של { name, quantity, unit_price, line_total }.
כל המחירים חייבים להיות עקביים: line_total = unit_price * quantity; וסכום ה-line_total שווה total_price.
אם אין מספיק מידע — החזר no_results בלבד.
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
    // שימוש בקלט כמחרוזת כדי להימנע מקונפליקטי טיפוסים
    input: JSON.stringify(payload),
    // ---- העיקר: response_format (אין text.format בכלל) ----
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

  if (!textCandidate) {
    throw new Error("LLM returned no text output");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(textCandidate);
  } catch {
    console.error("Model output (not JSON):", textCandidate);
    throw new Error("Failed to parse model JSON");
  }

  // הבטחת עקביות total_price
  if (parsed.status === "ok" && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (Array.isArray(r.basket)) {
        const sum = r.basket.reduce(
          (acc: number, line: any) => acc + Number(line.line_total ?? 0),
          0
        );
        r.total_price = Number(sum);
      }
    }
  }

  return parsed;
}

// ---- Start on Deno Deploy ----
// אין פורט; Deploy מספק את ה-HTTP runtime.
Deno.serve(app.fetch);
