# 彼日 · Nascence

**[中文](README_CN.md)**

> Enter your birthday. Meet someone born on the same day, sixty years before you. Read a letter they wrote across time.

**[nascence.pages.dev](https://nascence.pages.dev)** · 6,000+ unique visitors · Taiwan · Hong Kong · Mainland China · US · Japan

---

## What It Is

Nascence does one small thing: it takes your birthday, steps back sixty years to the same date, finds a notable person born that day, and uses AI to write you a letter in their voice.

Not inspirational. Not sentimental. More like a quiet recognition — *you and them, arriving on the same day.*

---

## Live Demo

🌐 **[nascence.pages.dev](https://nascence.pages.dev)**

No sign-up required. Rate-limited to 5 requests per IP per day.

---

## Architecture

```
Browser (HTML + JS)
    │  SSE streaming
    ▼
Cloudflare Pages Functions   ← API proxy layer
    │  HTTPS
    ▼
SiliconFlow API → DeepSeek V3   ← content generation

Cloudflare KV (×2)
  ├── RATE_LIMIT_KV   IP-based rate limiting (5/day)
  └── CACHE_KV        Celebrity data cache (24h TTL)
```

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla HTML + JavaScript | No framework, lightweight |
| Hosting | Cloudflare Pages | Static asset CDN |
| API Proxy | Cloudflare Pages Functions | Request forwarding, key protection |
| AI | SiliconFlow API · DeepSeek V3 | Letter + profile content generation |
| Rate limiting | Cloudflare KV (RATE_LIMIT_KV) | Per-IP daily counter |
| Caching | Cloudflare KV (CACHE_KV) | Celebrity data, 24h TTL |

Responses are streamed via **SSE (Server-Sent Events)** — the letter appears character by character rather than all at once.

---

## Local Development

**Requirements:** Node.js 18+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
git clone https://github.com/warrior1803-wang/nascence.git
cd nascence

npm install -g wrangler

# KV is simulated locally — no real IDs needed
wrangler dev
```

Fill in your KV namespace IDs in `wrangler.toml` (create them in Cloudflare Dashboard → Workers & Pages → KV):

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<your-kv-id>"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "<your-kv-id>"
```

Set the API key as a secret (never commit it):

```bash
wrangler secret put SILICONFLOW_API_KEY
```

---

## Design Notes

### Pages Functions as a GFW bypass

SiliconFlow's API domain is blocked by China's Great Firewall. A direct call from the browser simply fails for mainland users.

Cloudflare's edge network includes nodes in Hong Kong and Taiwan with strong accessibility from mainland China. By routing requests through Pages Functions — which live on that edge — the browser calls `pages.dev` (reachable), and the Function forwards the request to SiliconFlow on its behalf. A silent relay, built into the infrastructure.

The API key stays server-side and never appears in frontend code.

### KV cache for cost control

AI calls aren't free. Many users share the same birthday month and day, but the answer to "who was born on this date?" doesn't change. There's no reason to ask the model the same question twice.

The strategy is layered: **celebrity data is cached for 24 hours; the letter is always generated fresh.**

This keeps costs bounded while preserving what matters — every letter is written for this particular moment. The same KV store handles rate limiting, keyed by IP + date, capping each IP at 5 requests per day.

### Tone

The system prompt contains a line: *not confiding, but observing; not consoling, but recognizing.* That's the register the whole project aims for — restrained, a little distant, but warm. No exclamation marks. No life advice.

Beyond the letter, each figure gets four structured sections: a one-sentence definition, a four-point timeline, a legacy statement, and three "imprints" — moments from their life that mirror something in yours. The structured sections are cached; the letter is always new.

---

## Inspiration

A Threads post by [@531531salty](https://www.threads.net/@531531salty) described a folk method for finding your "eight-character twin" — someone whose Chinese astrological chart mirrors yours. The trick: subtract 60 years from your birth year, find a celebrity born on the same lunar date, and ask an AI who that person is.

The post got 2,000 likes. Something about it stuck.

Nascence is a simplified, more accessible version of that idea — no lunar calendar required, just your birthday.

<img src="assets/inspiration.png" width="480" alt="Threads post by 531531salty" />

---

## License

MIT
