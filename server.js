// Lecture Bridge server: serves the page and talks to the Claude API so the API key stays secret.
// No dependencies. Needs Node 18 or newer.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLASS_CODE = (process.env.CLASS_CODE || "").trim();          // optional: stops strangers from using your key
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "claude-haiku-5-5";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-sonnet-5-5";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "public", "index.html");

if (!API_KEY) console.warn("ANTHROPIC_API_KEY is not set. Translation will not work until you add it.");

/* ---------- Claude API ---------- */
async function askClaude(model, prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}
function parseJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? body.slice(a, b + 1) : body);
}
const str = (v, n) => String(v ?? "").slice(0, n);

/* ---------- prompts ---------- */
const translatePrompt = (text, context) => `You are the live interpreter for a university lecture. The professor speaks English; Korean-speaking students read your Korean captions in real time on their phones.

Earlier lines, for context only (do not translate these):
"""${context}"""

Translate ONLY this new line into natural, easy-to-read Korean:
"""${text}"""

Rules:
- Use clear spoken-lecture Korean (합니다/해요 style), not stiff word-for-word translation.
- For an academic or technical term, write the Korean term followed by the English in parentheses, e.g. 기억 응고화(memory consolidation).
- Keep names, numbers, formulas and course codes as they are.
- The English came from speech recognition with no punctuation; quietly fix obvious mishearings.
- Reply with the Korean translation only, with no notes or quotes.`;

const summaryPrompt = (transcript, prevTerms) => `Here is the running English transcript of a university lecture (from speech recognition, so it may contain small errors and no punctuation).

TRANSCRIPT:
"""${transcript}"""

Write study help for Korean-speaking students. Reply with only this JSON:
{"ko":["..."],"en":["..."],"terms":[{"term":"English term","ko":"한국어 용어","def_ko":"한 문장의 쉬운 한국어 설명"}]}

- "ko": 4-8 short bullet points summarizing the lecture so far, in clear Korean, in the order topics came up.
- "en": the same bullets in simple English, same count and order as "ko".
- "terms": up to 20 key academic or technical terms a student should know from this lecture, most important first. Keep these previously listed terms if still relevant: ${prevTerms || "(none)"}.`;

const studyPrompt = transcript => `Here is the English transcript of a university lecture (from speech recognition).

TRANSCRIPT:
"""${transcript}"""

Make a short study guide in Korean for Korean-speaking students. Reply with only this JSON:
{"takeaways":[{"ko":"...","en":"..."}],"questions":[{"q":"한국어 질문","a":"한국어 정답 (1-3 문장)"}]}

- "takeaways": the 3-6 most important ideas, each in Korean with a simple English version.
- "questions": 6-8 review questions that check understanding, not just memory, with short Korean answers. Keep key English terms in parentheses where helpful.`;

/* ---------- simple per-device rate limits ---------- */
const hits = new Map();
function allowed(ip, kind, perMinute) {
  const key = ip + "|" + kind, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < 60_000);
  if (list.length >= perMinute) { hits.set(key, list); return false; }
  list.push(now); hits.set(key, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k); }, 300_000).unref();

/* ---------- http ---------- */
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": type.startsWith("text/html") ? "no-cache" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "microphone=(self)",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req, limit = 400_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try { return send(res, 200, await readFile(INDEX, "utf8"), "text/html; charset=utf-8"); }
    catch { return send(res, 500, "Page missing", "text/plain"); }
  }
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

  if (CLASS_CODE && (req.headers["x-class-code"] || "").trim() !== CLASS_CODE) return send(res, 401, { error: "class code required" });
  if (!API_KEY) return send(res, 503, { error: "server has no API key" });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: "bad request" }); }

  try {
    if (url.pathname === "/api/translate") {
      if (!allowed(ip, "t", 90)) return send(res, 429, { error: "slow down" });
      const text = str(body.text, 1500).trim();
      if (!text) return send(res, 400, { error: "no text" });
      const ko = await askClaude(TRANSLATE_MODEL, translatePrompt(text, str(body.context, 1200)), 600);
      return send(res, 200, { ko });
    }
    if (url.pathname === "/api/summary") {
      if (!allowed(ip, "s", 6)) return send(res, 429, { error: "slow down" });
      const prev = Array.isArray(body.prevTerms) ? body.prevTerms.slice(0, 30).map(t => str(t, 80)).join(", ") : "";
      const out = parseJSON(await askClaude(SUMMARY_MODEL, summaryPrompt(str(body.transcript, 60000), prev), 3000));
      return send(res, 200, {
        ko: (out.ko || []).slice(0, 10).map(s => str(s, 400)),
        en: (out.en || []).slice(0, 10).map(s => str(s, 400)),
        terms: (out.terms || []).filter(t => t && t.term).slice(0, 25).map(t => ({ term: str(t.term, 80), ko: str(t.ko, 80), def_ko: str(t.def_ko, 300) })),
      });
    }
    if (url.pathname === "/api/study") {
      if (!allowed(ip, "q", 3)) return send(res, 429, { error: "slow down" });
      const out = parseJSON(await askClaude(SUMMARY_MODEL, studyPrompt(str(body.transcript, 80000)), 4000));
      return send(res, 200, {
        takeaways: (out.takeaways || []).filter(t => t && t.ko).slice(0, 8).map(t => ({ ko: str(t.ko, 400), en: str(t.en, 400) })),
        questions: (out.questions || []).filter(q => q && q.q).slice(0, 12).map(q => ({ q: str(q.q, 400), a: str(q.a, 800) })),
      });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(url.pathname, e.message);
    return send(res, 502, { error: "translation service error" });
  }
});

server.listen(PORT, () => console.log(`Lecture Bridge running on http://localhost:${PORT}`));
