// server_deno.ts
import { Hono } from "https://deno.land/x/hono@v4.4.7/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.4.7/middleware.ts";

// Load env
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY")!;
const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_KEY")!;
const GOOGLE_CSE_CX = Deno.env.get("GOOGLE_CSE_CX")!;

const app = new Hono();

// === Middleware ===
app.use("/*", cors());

// === PROMPT for ChatGPT-only (no protections) ===
const PROMPT_FREE = `
You are a shopping assistant AI.

The user will provide:
- Address (city/street)
- Search radius in kilometers
- Shopping list in free text

Your task:
1. Parse the shopping list into structured items:
- name (string)
- quantity (number or string, keep as written if unclear)
- brand (string, if known; otherwise leave empty or guess a common brand)
- unit_price (string or number, can be an estimate, a range, or "unknown")
- line_total (string or number, can be approximate, e.g. "~25₪")
- substitution (boolean, true if you guessed a replacement)
- notes (string, optional comments)

2. Aggregate items into a basket.

3. Suggest 3–4 nearby stores (you may invent realistic ones if no real data).
Each store must have:
- store_name
- address
- distance_km
- basket (the items with their prices, even approximate or textual)
- total_price (string or number, can be approximate)
- currency: "₪"

⚠️ Important:
- Never leave fields out.
- It is allowed to invent values, estimates, or ranges if you don’t know.
- Do NOT replace with 0 unless the user explicitly wrote "0".
- Always output structured JSON only.

Return JSON with:
{
"status":"ok",
"results":[ ... ]
}
`;

// === Utility: Call OpenAI ===
async function callOpenAI(prompt: string, input: string) {
console.log("🔵 callOpenAI invoked with prompt length:", prompt.length);

const res = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Authorization": `Bearer ${OPENAI_KEY}`,
"Content-Type": "application/json",
},
body: JSON.stringify({
model: "gpt-4o-mini", // אפשר לשנות ל-gpt-4o או gpt-5 אם פתוח לך
messages: [
{ role: "system", content: prompt },
{ role: "user", content: input },
],
temperature: 0.7,
}),
});

const data = await res.json();
console.log("🔵 OpenAI raw response:", data);

if (!res.ok) throw new Error(JSON.stringify(data));

let text = data.choices?.[0]?.message?.content;
if (!text) throw new Error("No content from OpenAI");

// Try parse JSON
try {
return JSON.parse(text);
} catch {
console.warn("⚠️ OpenAI returned invalid JSON, wrapping...");
return { status: "ok", results: [], raw: text };
}
}

// === Utility: Google CSE search ===
async function searchGoogleCSE(query: string) {
console.log("🌐 searchGoogleCSE query:", query);

const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_CX}`;
const res = await fetch(url);
const data = await res.json();
console.log("🌐 GoogleCSE raw:", data);

if (!res.ok) throw new Error(JSON.stringify(data));

return data.items?.map((it: any) => ({
title: it.title,
link: it.link,
snippet: it.snippet,
})) || [];
}

// === API ===
app.post("/api/search", async (c) => {
try {
const body = await c.req.json();
console.log("📥 Incoming request:", body);

const { address, radius_km, list_text, mode } = body;

if (mode === "web") {
// With Google CSE
const query = `מחירים ${list_text} ליד ${address} בקוטר ${radius_km} ק"מ`;
const webResults = await searchGoogleCSE(query);

const llmInput = `
User query:
Address: ${address}
Radius: ${radius_km} km
List: ${list_text}

Here are some search snippets:
${webResults.map(r => `- ${r.title}: ${r.snippet} (${r.link})`).join("\n")}

Please use these to build structured JSON results.
`;

const llmRes = await callOpenAI(PROMPT_FREE, llmInput);
return c.json(llmRes);
}

// Default: ChatGPT only
const input = `
Address: ${address}
Radius: ${radius_km} km
List: ${list_text}
`;
const llmRes = await callOpenAI(PROMPT_FREE, input);
return c.json(llmRes);

} catch (err: any) {
console.error("🔥 API error:", err);
return c.json({ status: "error", message: err.message || String(err) }, 500);
}
});

// === Root route ===
app.get("/", (c) => c.text("CartCompare AI server is running ✅"));

Deno.serve(app.fetch);