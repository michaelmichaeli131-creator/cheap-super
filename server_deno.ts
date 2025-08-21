// server_deno.ts
// Deno + Hono server for "השוואת סל קניות בסופרמרקטים"
// Uses OpenAI Responses API with strict JSON schema output.

import { Hono } from "@hono/hono";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveStatic } from "@hono/serve-static";
import { OpenAI } from "@openai/openai";

type ShoppingItem = { name: string; quantity: number };
type SearchRequest = {
  address?: string;
  radius_km?: number;
  shopping_list?: ShoppingItem[];
};

// ---- Environment ----
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set. Set it before running the server.");
}

const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

// ---- OpenAI client ----
const client = new OpenAI({ apiKey: OPENAI_API_KEY ?? "" });

// ---- Hono app ----
const app = new Hono();

// Static root (so /, /Super%20index.html, /assets, etc. are served if present)
app.use("/*", serveStatic({ root: "./" }));

// Root route explicitly serves the HTML if present
app.get("/", async (c) => {
  try {
    const html = await Deno.readTextFile("Super index.html");
    return c.html(html);
  } catch (_err) {
    return c.text(
      "Super index.html not found. Make sure the file is in the same folder as server_deno.ts",
      500,
    );
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
  if (typeof body.radius_km !== "number" || !isFinite(body.radius_km!)) needed.push("radius_km");
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
  // Prompt/instructions to the model
  const instructions = `
אתה מסייע בבניית השוואת מחירים לסל קניות בסופרמרקטים בישראל.
קבל כתובת/עיר, רדיוס בק"מ ורשימת מוצרים (שם + כמות).
החזר JSON בלבד לפי הסכמה שניתנת עם שדות:
- status: "ok" | "no_results" | "need_input" | "error"
- needed: רשימת שדות חסרים (אם need_input)
- results: מערך של חנויות כאשר לכל חנות:
  rank (מספר עולה לפי מחיר כולל),
  store_name (string),
  address (string),
  distance_km (מספר),
  currency (string, לדוגמה "₪"),
  total_price (מספר),
  basket: מערך של שורות { name, quantity, unit_price, line_total }.
כל המחירים והחישובים חייבים להיות עקביים מתמטית: line_total = unit_price * quantity; וסכום כל line_total = total_price.
אם אין מספיק מידע סביר לייצר תוצאות, החזר no_results.
אל תוסיף שדות נוספים מעבר לסכמה.
`;

  const response = await client.responses.create({
    model: MODEL,
    instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              address: req.address,
              radius_km: req.radius_km,
              shopping_list: req.shopping_list,
            }),
          },
        ],
      },
    ],
    // -------- FIX: use response_format instead of invalid `text.format` --------
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "SearchResults",
        strict: true,
        schema: {
          type: "object",
          properties: {
            status: { enum: ["ok", "no_results", "need_input", "error"] },
            needed: {
              type: "array",
              items: { type: "string" },
            },
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
                        line_total: { type: "number" },
                      },
                      required: ["name", "quantity", "unit_price", "line_total"],
                      additionalProperties: false,
                    },
                  },
                },
                required: [
                  "rank",
                  "store_name",
                  "address",
                  "distance_km",
                  "currency",
                  "total_price",
                  "basket",
                ],
                additionalProperties: false,
              },
            },
          },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
    temperature: 0.2,
    max_output_tokens: 1200,
  });

  // Try to read JSON from the Responses API in a robust way
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
  } catch (e) {
    console.error("Failed to parse model JSON:", textCandidate);
    throw new Error("Failed to parse model JSON");
  }

  // Basic sanity checks
  if (parsed.status === "ok" && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (Array.isArray(r.basket)) {
        const sum = r.basket.reduce(
          (acc: number, line: any) => acc + Number(line.line_total ?? 0),
          0,
        );
        r.total_price = Number(sum);
      }
    }
  }

  return parsed;
}

// ---- Start server ----
const port = Number(Deno.env.get("PORT") ?? "8000");
console.log(`🛒 Supermarket compare server listening on http://localhost:${port}`);
serve(app.fetch, { port });
