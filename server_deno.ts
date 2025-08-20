/// <reference no-default-lib="true"/>
import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/serve-static";
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
[... כל ה-System Prompt המלא שנתתי קודם ...]
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
    return JSON.parse(text);
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
