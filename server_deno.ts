// server_deno.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.24.0/mod.ts";

// הגדרת הלקוח מול OpenAI
const client = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
});

// שרת HTTP פשוט
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method === "POST" && new URL(req.url).pathname === "/find-cheapest") {
    try {
      const { itemsText, address, radius } = await req.json();

      if (!itemsText || !address || !radius) {
        return new Response(
          JSON.stringify({ status: "error", message: "חסר מידע: itemsText / address / radius" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          },
        );
      }

      // קריאה ל־OpenAI עם פורמט JSON מובנה
      const response = await client.responses.create({
        model: "gpt-4.1",
        input: `
          בבקשה מצא את המחיר הזול ביותר עבור הפריטים הבאים:
          ${itemsText}

          ברדיוס ${radius} ק"מ סביב הכתובת ${address}.
          החזר תשובה בפורמט JSON בלבד.
        `,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "shopping_result",
            schema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      quantity: { type: "number" },
                      store: { type: "string" },
                      price: { type: "number" },
                    },
                    required: ["name", "quantity", "store", "price"],
                  },
                },
                total_price: { type: "number" },
                cheapest_store: { type: "string" },
              },
              required: ["items", "total_price", "cheapest_store"],
            },
          },
        },
      });

      return new Response(
        JSON.stringify({ status: "ok", data: response.output_parsed }),
        {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    } catch (err) {
      console.error("Error:", err);
      return new Response(
        JSON.stringify({ status: "error", message: "LLM request failed: " + err.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    }
  }

  return new Response("Not found", { status: 404 });
});
