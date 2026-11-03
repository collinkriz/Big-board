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
    reporting: num(v.reporting),
    note: str(v.note, 80) || undefined,
    caller: str(v.caller, 30) || undefined,
    updated: str(v.updated, 30) || undefined,
    cands: Array.isArray(v.cands)
      ? v.cands.slice(0, 4).map((c) => ({ name: str(c && c.name, 40), party: PARTY.has(c && c.party) ? c.party : "I", pct: num(c && c.pct) ?? 0 }))
      : [],
  };
}

export default async (req) => {
  const store = getStore({ name: "bigboard", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/^\/api/, "");

  if (req.method === "GET" && path === "/state") {
    const calls = (await store.get("calls", { type: "json" })) || {};
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
    return json({ calls, picks });
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
      if (c) calls[k] = c; else delete calls[k];
      n++;
    }
    if (n) await store.setJSON("calls", calls);
    return json({ ok: true, updated: n });
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/*" };
