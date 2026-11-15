import words from "../data/words.json";

const byId = new Map(words.map((w) => [w.id, w]));
const TIME_ZONE = "America/Los_Angeles";

// YYYY-MM-DD in your time zone, so the word changes at local midnight.
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const publicWord = (w, withSentences) => ({
  id: w.id,
  roman: w.roman,
  english: w.english,
  category: w.category,
  ...(withSentences ? { sentences: w.sentences ?? [] } : {}),
});

// Get today's row, creating it on the first visit of the day.
async function getOrCreateDay(db, date) {
  const existing = await db.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
  if (existing) return existing;

  // Word of the day: random word not shown before (start over once all are used).
  const { results: used } = await db.prepare("SELECT word_id FROM days").all();
  const usedIds = new Set(used.map((r) => r.word_id));
  let pool = words.filter((w) => !usedIds.has(w.id));
  if (pool.length === 0) pool = words;
  const word = pool[Math.floor(Math.random() * pool.length)];

  // Review word: a past word, preferring ones you've practiced the least.
  const review = await db
    .prepare(
      `SELECT d.word_id, COUNT(p.id) AS times
       FROM days d LEFT JOIN practice p ON p.word_id = d.word_id
       WHERE d.date < ? AND d.word_id != ?
       GROUP BY d.word_id
       ORDER BY times ASC, RANDOM()
       LIMIT 1`
    )
    .bind(date, word.id)
    .first();

  // INSERT OR IGNORE handles two first-visits racing each other.
  await db
    .prepare("INSERT OR IGNORE INTO days (date, word_id, review_word_id) VALUES (?, ?, ?)")
    .bind(date, word.id, review?.word_id ?? null)
    .run();
  return db.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
}

async function handleToday(env) {
  const date = today();
  const day = await getOrCreateDay(env.DB, date);
  const word = byId.get(day.word_id);
  const reviewWord = day.review_word_id ? byId.get(day.review_word_id) : null;

  let practiced = null;
  if (reviewWord) {
    practiced = await env.DB
      .prepare("SELECT sentence1, sentence2 FROM practice WHERE date = ? AND word_id = ? ORDER BY id DESC LIMIT 1")
      .bind(date, reviewWord.id)
      .first();
  }

  return json({
    date,
    word: publicWord(word, true),
    // Example sentences for the review word stay hidden until you've written yours.
    review: reviewWord ? publicWord(reviewWord, Boolean(practiced)) : null,
    practiced,
  });
}

async function handlePractice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const s1 = String(body.sentence1 ?? "").trim();
  const s2 = String(body.sentence2 ?? "").trim();
  if (!s1 || !s2) return json({ error: "Write both sentences." }, 400);
  if (s1.length > 500 || s2.length > 500) return json({ error: "Keep each sentence under 500 characters." }, 400);

  const date = today();
  const day = await getOrCreateDay(env.DB, date);
  if (!day.review_word_id) return json({ error: "No practice word today." }, 400);

  await env.DB
    .prepare("INSERT INTO practice (date, word_id, sentence1, sentence2) VALUES (?, ?, ?, ?)")
    .bind(date, day.review_word_id, s1, s2)
    .run();

  return json({
    review: publicWord(byId.get(day.review_word_id), true),
    practiced: { sentence1: s1, sentence2: s2 },
  });
}

async function handleHistory(env) {
  const { results: days } = await env.DB
    .prepare("SELECT date, word_id FROM days ORDER BY date DESC LIMIT 60")
    .all();
  return json(
    days.map((d) => ({ date: d.date, word: publicWord(byId.get(d.word_id), false) }))
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/today" && request.method === "GET") return await handleToday(env);
      if (pathname === "/api/practice" && request.method === "POST") return await handlePractice(request, env);
      if (pathname === "/api/history" && request.method === "GET") return await handleHistory(env);
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong." }, 500);
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};
