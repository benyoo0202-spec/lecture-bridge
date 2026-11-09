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
const API_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const DOC_MODEL = process.env.DOC_MODEL || "claude-sonnet-5-5";        // writes the detailed document summary
const NOTES_MODEL = process.env.NOTES_MODEL || "claude-haiku-5-5";     // reads parts of very long documents first
const DOC_MAX_CHARS = 1_500_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "public", "index.html");

if (!API_KEY) console.warn("ANTHROPIC_API_KEY is not set. Translation will not work until you add it.");

/* ---------- Claude API ---------- */
async function askClaude(model, prompt, maxTokens) {
  const r = await fetch(API_BASE + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}
// Streams Claude's answer to the browser piece by piece, so Korean appears while it is being written.
async function streamClaude(model, prompt, maxTokens, res) {
  const r = await fetch(API_BASE + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", wrote = 0;
  const write = text => {
    // Headers go out only once real text arrives, so an empty or failed stream can still fall back.
    if (!res.headersSent) res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write(text); wrote += text.length;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) write(ev.delta.text);
        else if (ev.type === "error") throw new Error("stream error: " + (ev.error?.message || "unknown"));
      }
    }
  } catch (e) {
    if (!wrote) throw e;            // nothing sent yet: let the caller fall back
    console.error("stream cut short:", e.message);
  }
  if (!wrote) throw new Error("stream returned no text");
  res.end();
}
// Streams a reply, calling onText(lengthSoFar) as it grows; returns the full text and why it stopped.
async function streamText(model, prompt, maxTokens, onText) {
  const r = await fetch(API_BASE + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", stop = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; onText?.(text.length); }
      else if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === "error") throw new Error("stream error: " + (ev.error?.message || "unknown"));
    }
  }
  if (!text.trim()) throw new Error("Claude returned no text");
  return { text, stop };
}

/* ---------- long documents ---------- */
// Rough token count: English is ~4 characters per token, Korean/Chinese/Japanese about 1 per character.
function estTokens(s) {
  let wide = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x2e7f) wide++;
  return Math.ceil((s.length - wide) / 4 + wide * 1.1);
}
// Split at paragraph breaks into parts of about `target` tokens.
function splitText(text, target) {
  const paras = text.split(/\n\s*\n/);
  const parts = []; let cur = "", curT = 0;
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ""; curT = 0; };
  for (let p of paras) {
    let t = estTokens(p);
    while (t > target) {                       // one huge paragraph: cut it by size
      const cutAt = Math.floor(p.length * (target / t));
      push(); parts.push(p.slice(0, cutAt)); p = p.slice(cutAt); t = estTokens(p);
    }
    if (curT + t > target) push();
    cur += (cur ? "\n\n" : "") + p; curT += t;
  }
  push();
  return parts;
}
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const notesPrompt = (part, i, n, focus) => `This is part ${i + 1} of ${n} of a long document a college student must study. Write detailed English study notes for THIS PART ONLY (about 500-800 words): its main arguments in order, the evidence and examples used, important names, dates, numbers, definitions and any memorable quotes (short). Do not add outside information.${focus ? `\nThe student especially wants: ${focus}` : ""}

PART ${i + 1}/${n}:
"""
${part}
"""`;

const docPrompt = (source, isNotes, focus, name) => `You are helping Korean-speaking college students in an American university understand an assigned text and prepare for class discussion.
${isNotes ? "The document was very long, so below are detailed notes made from each part of it, in order." : "Below is the full document."}${name ? `\nFile name: ${name}` : ""}${focus ? `\nThe student's request (follow it): ${focus}` : ""}

${isNotes ? "NOTES" : "DOCUMENT"}:
"""
${source}
"""

Reply with only this JSON (no other text):
{"title_ko":"","title_en":"",
 "overview":{"ko":"","en":""},
 "sections":[{"heading_ko":"","heading_en":"","ko":"","en":""}],
 "key_points":[{"ko":"","en":""}],
 "terms":[{"term":"English term","ko":"한국어 용어","def_ko":"한 문장의 쉬운 한국어 설명"}],
 "questions":[{"type":"이해|분석|적용|토론","ko":"","en":"","hint_ko":""}]}

Rules:
- overview: 4-6 sentences on what the text is about and its main claim.
- sections: a DETAILED summary that follows the text's own structure and order, 4-10 sections. Each "ko" is 5-9 sentences keeping the important arguments, evidence, examples, names, numbers and dates; each "en" says the same in clear English.
- key_points: the 5-8 most important takeaways.
- terms: up to 12 key terms from the text.
- questions: 8-10 open-ended discussion questions a student could ask or answer in class. Mix the types (이해 = understanding, 분석 = analysis, 적용 = connecting to real life or other ideas, 토론 = debatable, no single right answer). Make each one specific to ideas in this text, not generic. Give the English version as a student would actually say it in class. hint_ko is one short Korean pointer to where in the text to look.
- Korean: natural academic 합니다체; put English in parentheses after technical terms, e.g. 기억 응고화(memory consolidation).
- Use only what is in the text; do not invent facts.`;

function cleanDoc(o) {
  const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
  const pair = (p, n) => ({ ko: str(p?.ko, n), en: str(p?.en, n) });
  return {
    title_ko: str(o.title_ko, 200), title_en: str(o.title_en, 200),
    overview: pair(o.overview, 2000),
    sections: arr(o.sections, 14).filter(s => s && (s.ko || s.en)).map(s => ({ heading_ko: str(s.heading_ko, 200), heading_en: str(s.heading_en, 200), ...pair(s, 4000) })),
    key_points: arr(o.key_points, 12).filter(k => k && (k.ko || k.en)).map(k => pair(k, 600)),
    terms: arr(o.terms, 16).filter(t => t && t.term).map(t => ({ term: str(t.term, 100), ko: str(t.ko, 100), def_ko: str(t.def_ko, 400) })),
    questions: arr(o.questions, 14).filter(q => q && (q.ko || q.en)).map(q => ({ type: str(q.type, 20), ...pair(q, 800), hint_ko: str(q.hint_ko, 300) })),
  };
}

function parseJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? body.slice(a, b + 1) : body);
}
const str = (v, n) => String(v ?? "").slice(0, n);

/* ---------- prompts ---------- */
// Kept short on purpose: a shorter prompt gets a faster first word back.
const translatePrompt = (text, context) => `Live Korean captions for an English university lecture, sent a few words at a time. Translate only the NEW part into natural spoken-lecture Korean (합니다/해요) so it reads smoothly after the earlier captions; it may be a sentence fragment. Put English in parentheses after technical terms, e.g. 기억 응고화(memory consolidation). Keep names and numbers. Quietly fix speech-recognition mistakes. Output only the Korean, never an explanation, even if the part is very short.
Earlier (do not translate): ${context || "(start)"}
NEW: ${text}`;

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
  try { body = await readBody(req, url.pathname === "/api/document" ? 7_000_000 : 400_000); }
  catch (e) { return send(res, e.message === "too large" ? 413 : 400, { error: "bad request", detail: e.message === "too large" ? "문서가 너무 큽니다" : "" }); }

  if (url.pathname === "/api/document") {
    if (!allowed(ip, "d", 4)) return send(res, 429, { error: "slow down" });
    const text = str(body.text, DOC_MAX_CHARS).trim();
    if (text.length < 200) return send(res, 400, { error: "too short", detail: "요약할 글이 너무 짧습니다" });
    const focus = str(body.focus, 300).trim(), name = str(body.name, 120).trim();

    // From here on the reply is a stream of JSON lines: progress steps, then the result (or an error).
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
    const emit = o => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };
    const keepAlive = setInterval(() => emit({ stage: "wait" }), 15_000);
    try {
      let source = text, isNotes = false;
      if (estTokens(text) > 60_000) {
        const parts = splitText(text, 25_000);
        let done = 0;
        emit({ stage: "reading", done, total: parts.length });
        const notes = await mapLimited(parts, 4, async (p, i) => {
          const n = await askClaude(NOTES_MODEL, notesPrompt(p, i, parts.length, focus), 2500);
          emit({ stage: "reading", done: ++done, total: parts.length });
          return n;
        });
        source = notes.map((n, i) => `[Part ${i + 1}/${parts.length}]\n${n}`).join("\n\n");
        isNotes = true;
      }
      const expect = 9000;
      emit({ stage: "writing", chars: 0, expect });
      let last = 0;
      const prompt = docPrompt(source, isNotes, focus, name);
      let out;
      try {
        out = await streamText(DOC_MODEL, prompt, 16000, n => { if (n - last >= 300) { last = n; emit({ stage: "writing", chars: n, expect }); } });
      } catch (e) {
        if (/Claude API (400|401|403|404)/.test(e.message)) throw e;
        console.error("document stream failed, retrying without streaming:", e.message);
        out = { text: await askClaude(DOC_MODEL, prompt, 16000), stop: "" };
      }
      let parsed;
      try { parsed = parseJSON(out.text); }
      catch { throw new Error(out.stop === "max_tokens" ? "결과가 너무 길어 잘렸습니다. 요청 사항에 '짧게'라고 적고 다시 시도하세요." : "결과를 읽을 수 없었습니다. 다시 시도하세요."); }
      emit({ result: cleanDoc(parsed) });
    } catch (e) {
      console.error("/api/document", e.message);
      emit({ error: String(e.message).slice(0, 240) });
    } finally { clearInterval(keepAlive); res.end(); }
    return;
  }

  try {
    if (url.pathname === "/api/translate") {
      if (!allowed(ip, "t", 150)) return send(res, 429, { error: "slow down" });
      const text = str(body.text, 1500).trim();
      if (!text) return send(res, 400, { error: "no text" });
      const prompt = translatePrompt(text, str(body.context, 700));
      try {
        return await streamClaude(TRANSLATE_MODEL, prompt, 600, res);
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch {} return; }
        console.error("stream failed, using normal reply:", e.message);
        const ko = await askClaude(TRANSLATE_MODEL, prompt, 600);
        if (!ko) throw new Error("Claude returned no text");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end(ko);
      }
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
    if (res.headersSent) { try { res.end(); } catch {} return; }
    // Pass a short reason back so the page can show what's wrong (never includes the key).
    return send(res, 502, { error: "translation service error", detail: String(e.message).slice(0, 240) });
  }
});

server.listen(PORT, () => console.log(`Lecture Bridge running on http://localhost:${PORT}`));
