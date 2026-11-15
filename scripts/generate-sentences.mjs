// Generates 2-3 romanized Urdu example sentences per word using Gemini.
// Usage: GEMINI_API_KEY=... node generate-sentences.mjs
// Safe to re-run: words that already have sentences are skipped.

import { readFile, writeFile } from "node:fs/promises";

const FILE = "/Users/arganoil/src/urdu-word-of-the-day/data/words.json";
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const API_KEY = process.env.GEMINI_API_KEY;
const BATCH_SIZE = 25;
const PAUSE_MS = 15_000; // stay under free-tier requests-per-minute limits

if (!API_KEY) {
  console.error("Set GEMINI_API_KEY first.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const responseSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "INTEGER" },
      sentences: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            roman: { type: "STRING" },
            english: { type: "STRING" },
          },
          required: ["roman", "english"],
        },
      },
    },
    required: ["id", "sentences"],
  },
};

function buildPrompt(batch) {
  const list = batch
    .map((w) => `${w.id}. ${w.roman} — ${w.english} (${w.category})`)
    .join("\n");
  return `You are an Urdu teacher. For each word or idiom below, write 3 natural example sentences in Urdu, written in Roman (Latin) script — no Urdu script — with an English translation of each.

Rules:
- Use the exact word or idiom in each sentence (conjugate verbs/idioms naturally).
- Use natural, everyday Pakistani/Indian Urdu, the way an educated speaker would say it.
- For "poetic" words, at least one sentence may sound literary; the others should show how it is used in modern speech or writing.
- For "idiom" entries, make the sentences show the idiomatic meaning clearly.
- Keep each sentence under 20 words.
- Return one object per id, using the same ids.

Words:
${list}`;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.7,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Empty response: ${JSON.stringify(data)}`);
  return JSON.parse(text);
}

const words = JSON.parse(await readFile(FILE, "utf8"));
const todo = words.filter((w) => !w.sentences?.length);
console.log(`Model: ${MODEL}. ${todo.length} of ${words.length} words need sentences.`);

for (let i = 0; i < todo.length; i += BATCH_SIZE) {
  const batch = todo.slice(i, i + BATCH_SIZE);
  const label = `Batch ${i / BATCH_SIZE + 1}/${Math.ceil(todo.length / BATCH_SIZE)}`;
  try {
    const results = await callGemini(buildPrompt(batch));
    let filled = 0;
    for (const r of results) {
      const w = words.find((x) => x.id === r.id);
      if (w && r.sentences?.length) {
        w.sentences = r.sentences.slice(0, 3);
        filled++;
      }
    }
    await writeFile(FILE, JSON.stringify(words, null, 2) + "\n");
    console.log(`${label}: filled ${filled}/${batch.length} — saved.`);
  } catch (err) {
    console.error(`${label} failed: ${err.message}`);
    console.error("Progress so far is saved. Re-run the script later to continue.");
    process.exit(1);
  }
  if (i + BATCH_SIZE < todo.length) await sleep(PAUSE_MS);
}

const missing = words.filter((w) => !w.sentences?.length).length;
console.log(missing ? `Done, but ${missing} words still missing — re-run to fill them.` : "All words have sentences.");
