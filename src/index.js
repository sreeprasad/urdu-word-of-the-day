import words from "../data/words.json";

const byId = new Map(words.map((w) => [w.id, w]));
const TIME_ZONE = "America/Los_Angeles";

// Resend's free plan allows 100 emails a day in total (confirmations + daily words).
const DAILY_EMAIL_CAP = 100;
const MAX_CONFIRMATIONS_PER_DAY = 20; // keeps sign-up spam from eating the daily quota

// YYYY-MM-DD in Pacific time, so the word changes at local midnight.
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const publicWord = (w) => ({
  id: w.id,
  roman: w.roman,
  urdu: w.urdu ?? null,
  english: w.english,
  category: w.category,
  sentences: w.sentences ?? [],
});

// ---------- Word of the day ----------

async function getOrCreateDay(db, date) {
  const existing = await db.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
  if (existing) return existing;

  // Random word not shown before (start over once all are used).
  const { results: used } = await db.prepare("SELECT word_id FROM days").all();
  const usedIds = new Set(used.map((r) => r.word_id));
  let pool = words.filter((w) => !usedIds.has(w.id));
  if (pool.length === 0) pool = words;
  const word = pool[Math.floor(Math.random() * pool.length)];

  // INSERT OR IGNORE handles two first visits racing each other.
  await db.prepare("INSERT OR IGNORE INTO days (date, word_id) VALUES (?, ?)").bind(date, word.id).run();
  return db.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
}

async function handleToday(env) {
  const date = today();
  const day = await getOrCreateDay(env.DB, date);
  return json({ date, word: publicWord(byId.get(day.word_id)) });
}

async function handleArchive(url, env) {
  const date = today();
  await getOrCreateDay(env.DB, date);
  const since = url.searchParams.get("since");
  const validSince = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : "0000-00-00";

  const { results } = await env.DB
    .prepare("SELECT date, word_id FROM days WHERE date <= ? AND date >= ? ORDER BY date DESC")
    .bind(date, validSince)
    .all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM days WHERE date <= ?").bind(date).first();

  return json({
    today: date,
    total: total.n,
    // The public archive leaves out today's word; the main page shows it.
    days: results
      .filter((d) => (since ? true : d.date !== date))
      .map((d) => ({ date: d.date, word: publicWord(byId.get(d.word_id)) })),
  });
}

// ---------- Email ----------

function siteUrl(env, request) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/$/, "");
  return request ? new URL(request.url).origin : "";
}

async function resendFetch(env, path, body) {
  const base = env.RESEND_API_URL || "https://api.resend.com";
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

async function emailsSentToday(db, date) {
  const confirms = await db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE confirm_sent_date = ?").bind(date).first();
  const daily = await db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE last_sent_date = ?").bind(date).first();
  return { confirms: confirms.n, daily: daily.n };
}

function confirmEmail(base, token) {
  const link = `${base}/confirm?token=${encodeURIComponent(token)}`;
  return {
    subject: "Confirm your Urdu word of the day emails",
    text: `Confirm that you want one Urdu word by email each morning:\n${link}\n\nIf you didn't ask for this, ignore this email and you won't hear from us again.`,
    html: `<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#1c2b5e;max-width:560px">
      <p>Confirm that you want one Urdu word by email each morning.</p>
      <p><a href="${esc(link)}" style="color:#1c2b5e">Confirm my subscription</a></p>
      <p style="color:#646b73;font-size:15px">If you didn't ask for this, ignore this email and you won't hear from us again.</p>
    </div>`,
  };
}

function dailyEmail(base, word, date, token) {
  const unsub = `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
  const sentencesHtml = (word.sentences || [])
    .map((s) => `<p style="margin:0 0 4px">${esc(s.roman)}</p><p style="margin:0 0 18px;color:#646b73">${esc(s.english)}</p>`)
    .join("");
  const sentencesText = (word.sentences || []).map((s) => `${s.roman}\n${s.english}`).join("\n\n");
  return {
    subject: `${word.roman}: ${word.english}`,
    unsub,
    text: `${word.roman}${word.urdu ? ` (${word.urdu})` : ""}\n${word.english}\n\n${sentencesText}\n\nPractise earlier words: ${base}/\n\nUnsubscribe: ${unsub}`,
    html: `<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#1c2b5e;max-width:560px">
      <p style="font-size:40px;line-height:1.2;font-weight:bold;margin:0 0 4px">${esc(word.roman)}</p>
      ${word.urdu ? `<p lang="ur" dir="rtl" style="font-family:'Noto Nastaliq Urdu','Jameel Noori Nastaleeq',serif;font-size:30px;line-height:2;margin:0;text-align:left">${esc(word.urdu)}</p>` : ""}
      <p style="font-size:19px;margin:0 0 24px">${esc(word.english)}</p>
      ${sentencesHtml}
      <p style="margin:24px 0 0"><a href="${esc(base)}/" style="color:#1c2b5e">Practise earlier words on the site</a></p>
      <p style="margin:32px 0 0;color:#646b73;font-size:14px">You get this because you subscribed to Urdu word of the day.
        <a href="${esc(unsub)}" style="color:#646b73">Unsubscribe</a></p>
    </div>`,
  };
}

async function handleSubscribe(request, env) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return json({ error: "Email subscriptions aren't switched on yet." }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const done = { message: "Check your inbox and click the link to confirm." };
  if (body.website) return json(done); // honeypot filled in: a bot

  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  const date = today();
  const existing = await env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first();
  if (existing?.status === "active") return json({ message: "You're already subscribed." });
  if (existing?.confirm_sent_date === date) return json(done); // don't resend on the same day

  const sent = await emailsSentToday(env.DB, date);
  if (sent.confirms >= MAX_CONFIRMATIONS_PER_DAY || sent.confirms + sent.daily >= DAILY_EMAIL_CAP) {
    return json({ error: "Too many sign-ups today. Try again tomorrow." }, 429);
  }

  const token = existing?.token || crypto.randomUUID();
  if (existing) {
    await env.DB.prepare("UPDATE subscribers SET status = 'pending', confirm_sent_date = ? WHERE id = ?")
      .bind(date, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO subscribers (email, token, status, confirm_sent_date) VALUES (?, ?, 'pending', ?)")
      .bind(email, token, date).run();
  }

  const msg = confirmEmail(siteUrl(env, request), token);
  try {
    await resendFetch(env, "/emails", { from: env.MAIL_FROM, to: [email], subject: msg.subject, html: msg.html, text: msg.text });
  } catch (err) {
    console.error(err);
    return json({ error: "The confirmation email didn't send. Try again later." }, 502);
  }
  return json(done);
}

// Daily send, run by the cron trigger.
async function sendDailyWord(env) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log("Daily email skipped: RESEND_API_KEY or MAIL_FROM not set.");
    return { sent: 0 };
  }
  const date = today();
  const day = await getOrCreateDay(env.DB, date);
  const word = byId.get(day.word_id);

  const sentToday = await emailsSentToday(env.DB, date);
  const room = Math.min(100, DAILY_EMAIL_CAP - sentToday.confirms - sentToday.daily); // batch max is 100
  if (room <= 0) return { sent: 0 };

  const { results: subs } = await env.DB
    .prepare("SELECT id, email, token FROM subscribers WHERE status = 'active' AND (last_sent_date IS NULL OR last_sent_date != ?) ORDER BY id LIMIT ?")
    .bind(date, room)
    .all();
  if (!subs.length) return { sent: 0 };

  const base = siteUrl(env);
  const batch = subs.map((s) => {
    const msg = dailyEmail(base, word, date, s.token);
    return {
      from: env.MAIL_FROM,
      to: [s.email],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: { "List-Unsubscribe": `<${msg.unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
  });

  await resendFetch(env, "/emails/batch", batch);
  await env.DB.batch(subs.map((s) => env.DB.prepare("UPDATE subscribers SET last_sent_date = ? WHERE id = ?").bind(date, s.id)));
  console.log(`Daily email: sent ${subs.length} for ${date} (${word.roman}).`);
  return { sent: subs.length };
}

// ---------- Confirm / unsubscribe pages ----------

function page(title, bodyHtml, status = 200) {
  const row = (html) => `<div class="row"><span class="note"></span><div class="text">${html}</div></div>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Urdu word of the day</title><link rel="stylesheet" href="/style.css" /></head>
<body>
<header class="row masthead"><span class="note"></span><div class="text"><a class="title" href="/">Urdu word of the day</a></div></header>
<div class="gap"></div>
${row(`<h2>${esc(title)}</h2>`)}
${bodyHtml.map(row).join("\n")}
</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function findByToken(db, url) {
  const token = url.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  return db.prepare("SELECT * FROM subscribers WHERE token = ?").bind(token).first();
}

// GET shows a button; POST does the change. Link scanners in mail apps only make GET requests.
async function handleConfirm(request, url, env) {
  const sub = await findByToken(env.DB, url);
  if (!sub) return page("That link doesn't work", ["It may be mistyped or out of date. <a href=\"/\">Subscribe again from the main page</a>."], 404);
  if (request.method === "POST") {
    await env.DB.prepare("UPDATE subscribers SET status = 'active', confirmed_at = datetime('now') WHERE id = ?").bind(sub.id).run();
    return page("You're subscribed", ["The word of the day will arrive each morning around 7 a.m. Pacific.", "<a href=\"/\">See today's word</a>"]);
  }
  if (sub.status === "active") return page("You're already subscribed", ["<a href=\"/\">See today's word</a>"]);
  return page("Confirm your subscription", [
    `Send ${esc(sub.email)} one Urdu word each morning.`,
    `<form method="post"><button class="save" type="submit">Confirm my subscription</button></form>`,
  ]);
}

async function handleUnsubscribe(request, url, env) {
  const sub = await findByToken(env.DB, url);
  if (!sub) return page("That link doesn't work", ["It may be mistyped or out of date."], 404);
  if (request.method === "POST") {
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").bind(sub.id).run();
    return page("You're unsubscribed", [`${esc(sub.email)} won't get any more emails.`, "<a href=\"/\">See today's word</a>"]);
  }
  if (sub.status === "unsubscribed") return page("You're already unsubscribed", ["<a href=\"/\">See today's word</a>"]);
  return page("Unsubscribe", [
    `Stop sending the daily word to ${esc(sub.email)}.`,
    `<form method="post"><button class="save" type="submit">Unsubscribe</button></form>`,
  ]);
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/api/today" && request.method === "GET") return await handleToday(env);
      if (pathname === "/api/archive" && request.method === "GET") return await handleArchive(url, env);
      if (pathname === "/api/subscribe" && request.method === "POST") return await handleSubscribe(request, env);
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      if (pathname === "/confirm" && ["GET", "POST"].includes(request.method)) return await handleConfirm(request, url, env);
      if (pathname === "/unsubscribe" && ["GET", "POST"].includes(request.method)) return await handleUnsubscribe(request, url, env);
      if (pathname === "/archive") return env.ASSETS.fetch(new Request(new URL("/archive.html", url), request));
    } catch (err) {
      console.error(err);
      if (pathname.startsWith("/api/")) return json({ error: "Something went wrong." }, 500);
      return page("Something went wrong", ["Refresh the page to try again."], 500);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyWord(env).catch((err) => console.error("Daily email failed:", err)));
  },
};
