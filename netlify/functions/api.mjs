// Big Board shared state: everyone's picks plus the host's race calls.
// Stored in Netlify Blobs. Host calls require the ADMIN_KEY environment variable.
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const RACE_KEY = /^(sen|house|gov)-[A-Z]{2}(-(\d{1,2}|AL))?$/;
const PARTY = new Set(["D", "R", "I"]);
const str = (v, n) => (v == null ? "" : String(v).slice(0, n));
const num = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : Math.max(0, Math.min(100, +v)));

function cleanPicks(p) {
  const out = {};
  if (!p || typeof p !== "object") return out;
  for (const [k, v] of Object.entries(p).slice(0, 300)) {
    if (RACE_KEY.test(k) && PARTY.has(v)) out[k] = v;
  }
  return out;
}

function cleanCall(v) {
  if (!v || typeof v !== "object") return null;
  return {
    winner: PARTY.has(v.winner) ? v.winner : null,
    lean: ["toss", "leanD", "leanR"].includes(v.lean) ? v.lean : undefined,
    reporting: num(v.reporting),
    note: str(v.note, 80) || undefined,
    caller: str(v.caller, 80) || undefined,
    updated: str(v.updated, 30) || undefined,
    cands: Array.isArray(v.cands)
      ? v.cands.slice(0, 4).map((c) => ({ name: str(c && c.name, 40), party: PARTY.has(c && c.party) ? c.party : "I", pct: num(c && c.pct) }))
      : [],
  };
}

// Headlines from major outlets across the spectrum. A feed that fails is skipped.
const FEEDS = [
  ["NPR", "https://feeds.npr.org/1014/rss.xml"],
  ["PBS NewsHour", "https://www.pbs.org/newshour/feeds/rss/politics"],
  ["BBC", "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"],
  ["NYT", "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml"],
  ["Fox News", "https://moxie.foxnews.com/google-publisher/politics.xml"],
  ["CBS News", "https://www.cbsnews.com/latest/rss/politics"],
  ["ABC News", "https://abcnews.go.com/abcnews/politicsheadlines"],
  ["Politico", "https://rss.politico.com/politics-news.xml"],
  ["The Hill", "https://thehill.com/homenews/campaign/feed/"],
  ["NBC News", "https://feeds.nbcnews.com/nbcnews/public/politics"],
];
const decode = (t) =>
  t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
   .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;|&apos;|&#8217;/g, "’").replace(/&#8216;/g, "‘").replace(/&#8220;|&#8221;/g, '"').replace(/&#8212;/g, "—").replace(/&#8211;/g, "–").trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};
async function readFeed([source, url]) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "BigBoard/1.0 (election night reader)" } });
    if (!r.ok) throw new Error(String(r.status));
    const xml = await r.text();
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    return blocks.slice(0, 25).map((b) => {
      let link = tag(b, "link");
      if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ""; }
      const when = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || tag(b, "dc:date");
      return { source, title: tag(b, "title"), link, ts: Date.parse(when) || 0 };
    }).filter((x) => x.title && /^https?:\/\//.test(x.link));
  } finally { clearTimeout(timer); }
}
let newsCache = { at: 0, body: null };

// Bluesky: original posts (no replies, no reposts) from a curated list of newsrooms and analysts.
const DEFAULT_HANDLES = [
  "apnews.com", "reuters.com", "npr.org", "nytimes.com", "washingtonpost.com", "wsj.com",
  "bloomberg.com", "politico.com", "axios.com", "nbcnews.com", "cnn.com", "propublica.org",
  "gelliottmorris.com", "daveweigel.bsky.social",
];
const HANDLE = /^[a-z0-9][a-z0-9.-]{1,252}\.[a-z]{2,}$/i;
let socialCache = { at: 0, key: "", body: null };
// Accounts whose posts are scanned for race calls (AP plus newsrooms that report the calls).
const CALL_HANDLES = ["apnews.com", "nbcnews.com", "npr.org", "cbsnews.com", "cnn.com", "nytimes.com", "washingtonpost.com"];
const CALL_WORDS = /\b(wins?|projected|projects|race call|defeats|reelected|re-elected|holds?)\b/i;
let callCache = { at: 0, body: null };
async function readAuthor(handle, limit = 20, cursor = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const u = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?filter=posts_no_replies&limit=${Math.max(1, Math.min(100, limit))}&actor=${encodeURIComponent(handle)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const items = (j.feed || []).filter((f) => !f.reason && f.post && f.post.record && f.post.record.text != null).map((f) => {
      const p = f.post, a = p.author || {}, e = p.embed || {};
      const rkey = String(p.uri || "").split("/").pop();
      const ext = e.external || (e.media && e.media.external);
      const imgs = e.images || (e.media && e.media.images) || [];
      return {
        handle: a.handle || handle, name: str(a.displayName || a.handle || handle, 60), avatar: a.avatar || "",
        text: str(p.record.text, 600), ts: Date.parse(p.record.createdAt || p.indexedAt) || 0,
        url: `https://bsky.app/profile/${a.handle || handle}/post/${rkey}`,
        link: ext ? { uri: ext.uri, title: str(ext.title, 140) } : null,
        image: imgs[0] ? imgs[0].thumb : "",
      };
    });
    items.cursor = j.cursor || null;
    return items;
  } finally { clearTimeout(timer); }
}
async function readAuthorPages(handle, pages) {
  let cursor = null; const out = [];
  for (let i = 0; i < pages; i++) {
    const page = await readAuthor(handle, 100, cursor);
    out.push(...page); cursor = page.cursor; if (!cursor) break;
  }
  return out;
}

export default async (req) => {
  const store = getStore({ name: "bigboard", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/^\/api/, "");

  if (req.method === "GET" && path === "/state") {
    const calls = (await store.get("calls", { type: "json" })) || {};
    const overrides = (await store.get("overrides", { type: "json" })) || {};
    const { blobs } = await store.list({ prefix: "picks/" });
    const picks = {};
    await Promise.all(
      blobs.map(async (b) => {
        const d = await store.get(b.key, { type: "json" });
        if (d) {
          const { token, ...pub } = d; // never send tokens back out
          picks[b.key.slice(6)] = pub;
        }
      })
    );
    return json({ calls, picks, overrides });
  }

  if (req.method === "GET" && path === "/news") {
    if (newsCache.body && Date.now() - newsCache.at < 90000) return json(newsCache.body);
    const results = await Promise.allSettled(FEEDS.map(readFeed));
    const items = [], failed = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? items.push(...r.value) : failed.push(FEEDS[i][0])));
    const seen = new Set();
    const uniq = items.filter((x) => { const k = x.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    uniq.sort((a, b) => b.ts - a.ts);
    newsCache = { at: Date.now(), body: { items: uniq.slice(0, 150), failed } };
    return json(newsCache.body);
  }

  if (req.method === "GET" && path === "/social") {
    const handles = (await store.get("social", { type: "json" })) || DEFAULT_HANDLES;
    const key = handles.join(",");
    if (socialCache.body && socialCache.key === key && Date.now() - socialCache.at < 60000) return json(socialCache.body);
    const results = await Promise.allSettled(handles.map((h) => readAuthor(h, 30)));
    const posts = [], failed = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? posts.push(...r.value) : failed.push(handles[i])));
    posts.sort((a, b) => b.ts - a.ts);
    socialCache = { at: Date.now(), key, body: { handles, failed, posts: posts.slice(0, 200) } };
    return json(socialCache.body);
  }

  if (req.method === "GET" && path === "/callposts") {
    if (callCache.body && Date.now() - callCache.at < 45000) return json(callCache.body);
    const archive = (await store.get("callarchive", { type: "json" })) || [];
    const cold = archive.length === 0; // first run: reach further back to catch calls already scrolled off
    const [results, heads] = await Promise.all([
      Promise.allSettled(CALL_HANDLES.map((h) => readAuthorPages(h, cold ? 3 : 1))),
      Promise.allSettled(FEEDS.map(readFeed)),
    ]);
    const posts = [];
    results.forEach((r) => { if (r.status === "fulfilled") posts.push(...r.value.filter((p) => CALL_WORDS.test(p.text) || (p.link && CALL_WORDS.test(p.link.title || "")))); });
    // news headlines (RSS) count as call sources too, labelled with the outlet's name
    heads.forEach((r) => { if (r.status === "fulfilled") posts.push(...r.value.filter((x) => CALL_WORDS.test(x.title)).map((x) => ({ handle: "rss", name: x.source, text: x.title, ts: x.ts || Date.now(), url: x.link, link: null }))); });
    // merge into the saved archive so calls are kept after they scroll out of the feeds
    const seen = new Set(archive.map((p) => p.url + "|" + p.text));
    let added = 0;
    for (const p of posts) { const id = p.url + "|" + p.text; if (!seen.has(id)) { seen.add(id); archive.push({ handle: p.handle, name: p.name, text: p.text, ts: p.ts, url: p.url, link: p.link ? { title: p.link.title } : null }); added++; } }
    const cutoff = Date.now() - 36 * 3600 * 1000;
    const kept = archive.filter((p) => p.ts >= cutoff).sort((a, b) => a.ts - b.ts).slice(-2000);
    if (added || kept.length !== archive.length) await store.setJSON("callarchive", kept);
    callCache = { at: Date.now(), body: { posts: kept, failed: CALL_HANDLES.filter((_, i) => results[i].status !== "fulfilled") } };
    return json(callCache.body);
  }

  if (req.method === "POST" && path === "/social") {
    const adminKey = Netlify.env.get("ADMIN_KEY");
    if (!adminKey || req.headers.get("x-admin-key") !== adminKey) return json({ error: "wrong host key" }, 403);
    const b = await req.json().catch(() => null);
    const list = [...new Set(((b && b.handles) || []).map((h) => String(h).trim().replace(/^@/, "").toLowerCase()).filter((h) => HANDLE.test(h)))].slice(0, 40);
    if (!list.length) return json({ error: "no valid handles" }, 400);
    await store.setJSON("social", list);
    socialCache = { at: 0, key: "", body: null };
    return json({ ok: true, handles: list });
  }

  // Uncall a wrong automatic call (blocks that winner for that race) or restore it.
  if (req.method === "POST" && path === "/override") {
    const b = await req.json().catch(() => null);
    if (!b || !RACE_KEY.test(b.key || "") || !["uncall", "restore", "call"].includes(b.action)) return json({ error: "bad request" }, 400);
    const overrides = (await store.get("overrides", { type: "json" })) || {};
    if (b.action === "uncall") {
      if (!PARTY.has(b.block)) return json({ error: "bad request" }, 400);
      overrides[b.key] = { block: b.block, by: str(b.by, 24), at: new Date().toISOString() };
    } else if (b.action === "call") {
      if (!PARTY.has(b.winner)) return json({ error: "bad request" }, 400);
      overrides[b.key] = { force: b.winner, by: str(b.by, 24), at: new Date().toISOString() };
    } else delete overrides[b.key];
    await store.setJSON("overrides", overrides);
    return json({ ok: true, overrides });
  }

  if (req.method === "POST" && path === "/picks") {
    const b = await req.json().catch(() => null);
    if (!b || !/^[a-f0-9]{8,40}$/.test(b.id || "") || typeof b.token !== "string" || b.token.length < 16)
      return json({ error: "bad request" }, 400);
    const key = "picks/" + b.id;
    const cur = await store.get(key, { type: "json" });
    if (cur && cur.token !== b.token) return json({ error: "not your picks" }, 403);
    if (cur && cur.locked) {
      cur.name = str(b.name, 24) || cur.name; // locked: only the name can change
      await store.setJSON(key, cur);
      return json({ ok: true, locked: true });
    }
    const now = new Date().toISOString();
    const doc = {
      token: b.token,
      name: str(b.name, 24),
      picks: cleanPicks(b.picks),
      tb: { sen: str(b.tb && b.tb.sen, 4), house: str(b.tb && b.tb.house, 4) },
      locked: !!b.locked,
      lockedAt: b.locked ? now : undefined,
      updated: now,
    };
    await store.setJSON(key, doc);
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/calls") {
    const adminKey = Netlify.env.get("ADMIN_KEY");
    if (!adminKey || req.headers.get("x-admin-key") !== adminKey) return json({ error: "wrong host key" }, 403);
    const b = await req.json().catch(() => null);
    const incoming = (b && b.calls) || {};
    const calls = (await store.get("calls", { type: "json" })) || {};
    let n = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (!RACE_KEY.test(k)) continue;
      const c = cleanCall(v);
      if (c) {
        const prev = calls[k];
        // stamp when a race is first called (or flips), so the calls feed can sort by it
        if (c.winner) c.calledAt = prev && prev.winner === c.winner && prev.calledAt ? prev.calledAt : new Date().toISOString();
        calls[k] = c;
      } else delete calls[k];
      n++;
    }
    if (n) await store.setJSON("calls", calls);
    return json({ ok: true, updated: n });
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/*" };
