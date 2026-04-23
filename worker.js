/**
 * 彼日 (nascence.app) — Cloudflare Worker
 *
 * Environment variables required (set in Cloudflare dashboard or wrangler.toml secrets):
 *   SILICONFLOW_API_KEY  — SiliconFlow API key
 *
 * Endpoints:
 *   POST /generate   — body: { date: "YYYY-MM-DD" }  (already minus 60 years)
 *                      Streams SSE back to frontend
 *   GET  /health     — simple liveness check
 */

const SILICONFLOW_API = "https://api.siliconflow.cn/v1/chat/completions";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Rate limiting (KV: RATE_LIMIT_KV) ─────────────────────────────────────────
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMIT_KV) return true; // KV not bound → skip (dev / Pages)
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `rate:${ip}:${today}`;
  const count = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0");
  if (count >= 5) return false;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 90000 });
  return true;
}

// ── Result cache (KV: CACHE_KV) ────────────────────────────────────────────────
// Cached: primary figure data, others list, parsed sections.
// Letter is always freshly generated (personalised each time).
async function getCached(env, key) {
  if (!env.CACHE_KV) return null;
  try {
    const raw = await env.CACHE_KV.get(`cache:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function setCache(env, key, data) {
  if (!env.CACHE_KV) return;
  try {
    await env.CACHE_KV.put(`cache:${key}`, JSON.stringify(data), { expirationTtl: 86400 });
  } catch {}
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { date, figureName, figureCn, figureBorn, figureDied, figureProfession } = body;
  // date: "YYYY-MM-DD" (already minus 60 years)
  // figureName: optional — if provided, skip discovery and generate for this specific figure
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: "date must be YYYY-MM-DD" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Rate limit check (only for new discovery requests, not figure-switching)
  if (!figureName) {
    const allowed = await checkRateLimit(request, env);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "今日查询次数已达上限，明日再来" }), {
        status: 429,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (obj) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    return writer.write(encoder.encode(line));
  };

  // Run pipeline in background so we can return the stream immediately
  (async () => {
    try {
      const [month, day] = [date.slice(5, 7), date.slice(8, 10)];
      const year = date.slice(0, 4);

      let primary;
      let others = [];
      let cachedSections = null;

      if (figureName) {
        // ── Direct figure mode: skip discovery & cache ──────────────────────
        primary = {
          en: figureName,
          cn: figureCn || figureName,
          born: figureBorn || parseInt(year),
          died: figureDied || null,
          profession: figureProfession || "",
        };
      } else {
        // ── Check cache first ───────────────────────────────────────────────
        const cached = await getCached(env, date);

        if (cached) {
          primary = cached.primary;
          others  = cached.others;
          cachedSections = cached.sections;
          console.log("Cache hit:", date);
        } else {
          // ── Discover figures (no cache) ───────────────────────────────────
          const figuresPrompt = `请列出公历${month}月${day}日出生的3-4位最著名的历史名人。
范围包括：政治家、艺术家、音乐家、作家、科学家、演员、运动员、商人、社会活动家等各领域。
优先推荐20世纪出生的人，其次是19世纪，以知名度高低排序。

严格要求：
- 必须是真实存在的历史名人
- 必须返回合法JSON数组
- 没有符合条件的就返回[]

格式：[{"en":"英文全名","cn":"中文名","born":出生年份数字,"died":去世年份或null,"profession":"职业2-4字","nationality":"国籍"}]
只返回JSON，不要其他文字。`;
          const figuresRaw = await callSiliconFlow(env, figuresPrompt, false);
          console.log("SiliconFlow raw response:", figuresRaw);

          let candidates;
          try {
            let cleaned = figuresRaw
              .replace(/```json\n?|\n?```/g, "")
              .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
              .trim();
            const match = cleaned.match(/\[[\s\S]*\]/);
            if (!match) throw new Error("No JSON array found");
            candidates = JSON.parse(match[0]);
            if (!Array.isArray(candidates)) throw new Error("Not an array");
          } catch (e) {
            console.log("Parse error:", e.message, "Raw:", figuresRaw);
            throw new Error("Failed to parse figures: " + e.message);
          }

          if (candidates.length === 0) {
            await send({ type: "empty", date: `${day} · ${month} · ${year}` });
            await send({ type: "done" });
            return;
          }

          primary = candidates[0];
          others  = candidates.slice(1, 4);
        }
      }

      // Format display values
      const bornDisplay  = `${day} · ${month} · ${primary.born}`;
      const yearsDisplay = primary.died
        ? `${primary.born} — ${primary.died}`
        : `${primary.born} — `;

      await send({
        type: "figure",
        en: primary.en, cn: primary.cn,
        born: bornDisplay, years: yearsDisplay,
        figureBorn: primary.born,
      });

      await send({
        type: "others",
        list: others.map((o) => ({
          en: o.en, cn: o.cn, born: o.born, died: o.died,
          years: o.died ? `${o.born} — ${o.died}` : `${o.born} — `,
          tag: o.profession,
          bornDisplay: `${day} · ${month} · ${o.born}`,
          profession: o.profession,
        })),
      });

      // ── Stream letter (always fresh) ────────────────────────────────────
      const contentPrompt = buildContentPrompt(primary, month, day);
      const stream = await callSiliconFlow(env, contentPrompt, true);

      if (cachedSections) {
        // Cache hit: stream letter only, then send cached sections
        await streamLetter(stream, send);
        await send({ type: "sections", ...cachedSections });
      } else {
        // Cache miss: stream letter + parse sections, then cache
        const fullText = await streamLetter(stream, send);
        const sections = parseContentSections(fullText);
        console.log("parsed sections:", JSON.stringify(sections));
        if (sections) {
          await send({ type: "sections", ...sections });
          // Cache figure/others/sections (not the letter)
          if (!figureName) {
            await setCache(env, date, { primary, others, sections });
          }
        }
      }

      await send({ type: "done" });
    } catch (err) {
      await send({ type: "error", message: err.message });
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── SiliconFlow API caller ─────────────────────────────────────────────────────

async function callSiliconFlow(env, prompt, stream = false) {
  const messages = stream
    ? [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ]
    : [{ role: "user", content: prompt }];

  const resp = await fetch(SILICONFLOW_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SILICONFLOW_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-ai/DeepSeek-V3",
      messages,
      stream,
      max_tokens: stream ? 2000 : 800,
      temperature: 0.85,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SiliconFlow API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  return resp; // return Response for streaming
}


// ── Content prompt builder ─────────────────────────────────────────────────────

function buildContentPrompt(figure, month, day) {
  const figureDate = `${figure.born}-${month}-${day}`;
  return `请为网站"彼日"生成关于 ${figure.en}（${figure.cn}）的完整内容。
他/她出生于 ${figureDate}（公历）。一位用户在同月同日出生。

请严格按照以下格式输出，使用标记分隔各部分，不要添加额外说明：

[LETTER]
（以${figure.cn}的口吻，写给60年后同天生日的"你"。4-6行，诗意克制，不用"亲爱的"开头，不要心灵鸡汤，要有距离感但温柔。可以夹杂少量英文。每行独立成段。）
[/LETTER]

[DEF]
（一句话定义此人，10-20字，诗意凝练，用"的"字结构，如：用一百个笔名活过一生的诗人）
[/DEF]

[TIMELINE]
（生平4个关键节点，每行格式：年份|一行描述，约15字以内）
[/TIMELINE]

[LEGACY]
（他/她留下了什么，2-3行，每行约15字，文学性表达）
[/LEGACY]

[IMPRINT]
（三段印记，每段2句。
第一句：描述这个历史人物的一个具体故事、选择或时刻，要有细节，不要泛泛而谈。
第二句：以"你也是"或"你也懂得"或"你也习惯"开头，直接定义读者，让读者感到被看见。
不要用"你若..."或"如果你..."这种假设句式，要直接肯定。
段与段之间用单独一行"---"分隔。

示例：
他在白内障几乎让他失明的晚年，仍然坚持作画，只是颜色变了。
你也是那种，即使看不清了，也不会停下来的人。
---
巴黎的沙龙三十次拒绝了他，他就自己办了展览。
你也习惯在没有门的地方，自己开一扇窗。
---
他画同一片睡莲画了三十年，每次都不一样。
你也懂得，重复不是执念，是一种深入。）
[/IMPRINT]`;
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是"彼日"（nascence.app）的内容创作者，专门撰写跨越时间的人文内容。

风格要求：
- 中文为主，偶尔夹杂英文单词或短语增添质感
- 诗意、克制、有距离感但温柔
- 避免心灵鸡汤、励志语气、过度煽情
- 不用感叹号，少用省略号
- 文字有重量，每句都在说真正想说的话
- 信件口吻：不是倾诉，是注视；不是安慰，是辨认`;

// ── Stream letter in real-time; return full accumulated text ──────────────────
// Sections are NOT sent here — caller decides whether to use cache or parse fresh.

async function streamLetter(response, send) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let accumulated = "";
  let inLetter = false;
  let letterDone = false;
  let letterBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;

      let chunk;
      try { chunk = JSON.parse(raw); } catch { continue; }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;

      accumulated += delta;

      if (!letterDone) {
        letterBuffer += delta;

        if (!inLetter && letterBuffer.includes("[LETTER]")) {
          inLetter = true;
          const idx = letterBuffer.indexOf("[LETTER]") + "[LETTER]".length;
          letterBuffer = letterBuffer.slice(idx);
        }

        if (inLetter) {
          const endIdx = letterBuffer.indexOf("[/LETTER]");
          if (endIdx !== -1) {
            const remaining = letterBuffer.slice(0, endIdx).trimStart();
            if (remaining) await send({ type: "letter_chunk", text: remaining });
            letterDone = true;
            inLetter = false;
          } else {
            const safeEnd = Math.max(0, letterBuffer.length - 10);
            if (safeEnd > 0) {
              await send({ type: "letter_chunk", text: letterBuffer.slice(0, safeEnd) });
              letterBuffer = letterBuffer.slice(safeEnd);
            }
          }
        }
      }
    }
  }

  return accumulated;
}

// ── Section parser ────────────────────────────────────────────────────────────

function parseContentSections(text) {
  const extract = (tag, content) => {
    // Try with closing tag first
    const re = new RegExp(`[*_]*\\[${tag}\\][*_]*([\\s\\S]*?)[*_]*\\[\\/${tag}\\][*_]*`);
    const m = content.match(re);
    if (m) return m[1].trim();
    // Fallback: no closing tag — grab everything after the opening tag
    const openRe = new RegExp(`[*_]*\\[${tag}\\][*_]*([\\s\\S]+)$`);
    const m2 = content.match(openRe);
    return m2 ? m2[1].trim() : "";
  };

  const defText = extract("DEF", text);
  const timelineRaw = extract("TIMELINE", text);
  const legacyRaw = extract("LEGACY", text);
  const imprintRaw = extract("IMPRINT", text);

  const timeline = timelineRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [yr, ...rest] = l.split("|");
      return { yr: yr.trim(), txt: rest.join("|").trim() };
    })
    .filter((t) => t.yr && t.txt);

  const legacy = legacyRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);


  const imprint = imprintRaw
    // Handle: \n---\n  /  \n\n---\n\n  /  ^---$  /  **---**  /  —— any combo
    .split(/\n[\s*_]*-{2,}[\s*_]*\n|\n[\s*_]*-{2,}[\s*_]*$|^[\s*_]*-{2,}[\s*_]*$/m)
    .map((s) => s.trim())
    .filter(Boolean);

  return { def: defText, timeline, legacy, imprint };
}
