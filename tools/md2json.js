#!/usr/bin/env node
// Convert a markdown deck to cards.json.
// Usage: node tools/md2json.js <input.md> [<output.json>]
//
// Format:
//   # Deck: <title>
//   id: <deck-id>
//   version: <n>
//
//   ---
//   id: <card-id>            (optional; auto-generated if missing)
//   mode: typed|cloze|mc
//   tags: tag1, tag2
//   hint: <optional hint>
//   Q: <prompt or cloze text with {{key}}>
//
//   # typed:
//   A: <accepted answer>     (repeatable)
//
//   # cloze:
//   <key>: <accepted answer> (one line per cloze key)
//
//   # mc:
//   *: <correct option>
//   -: <distractor>          (repeatable)

const fs = require("fs");
const path = require("path");

const [inPath, outPath] = process.argv.slice(2);
if (!inPath) {
  console.error("Usage: node tools/md2json.js <input.md> [<output.json>]");
  process.exit(1);
}

const src = fs.readFileSync(inPath, "utf8");
const deck = parseDeck(src);
const json = JSON.stringify({ deck }, null, 2);

if (outPath) {
  fs.writeFileSync(outPath, json);
  console.log(`Wrote ${outPath} — ${deck.cards.length} cards.`);
} else {
  process.stdout.write(json + "\n");
}

function parseDeck(src) {
  const sections = src.split(/^---\s*$/m);
  const header = sections.shift();
  const deck = parseHeader(header);
  deck.cards = sections.map(parseCard).filter(Boolean);
  // Auto-assign ids if missing
  const seen = new Set();
  deck.cards.forEach((c, i) => {
    if (!c.id) c.id = `c${String(i + 1).padStart(3, "0")}`;
    if (seen.has(c.id)) throw new Error(`Duplicate card id: ${c.id}`);
    seen.add(c.id);
  });
  return deck;
}

function parseHeader(text) {
  const out = { id: "deck", title: "Untitled", version: 1, cards: [] };
  for (const line of text.split(/\r?\n/)) {
    const titleMatch = line.match(/^#\s*Deck:\s*(.+)$/);
    if (titleMatch) { out.title = titleMatch[1].trim(); continue; }
    const kv = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (kv) {
      const [, k, v] = kv;
      if (k === "id") out.id = v.trim();
      else if (k === "version") out.version = Number(v.trim());
      else if (k === "title") out.title = v.trim();
    }
  }
  return out;
}

function parseCard(text) {
  text = text.trim();
  if (!text) return null;

  const card = {};
  const lines = text.split(/\r?\n/);
  const answers = [];
  const distractors = [];
  const cloze = {};
  let promptLines = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;

    let m;
    if ((m = line.match(/^Q:\s*(.*)$/))) { promptLines.push(m[1]); continue; }
    if ((m = line.match(/^A:\s*(.*)$/))) { answers.push(m[1]); continue; }
    if ((m = line.match(/^\*:\s*(.*)$/))) { card.correct = m[1]; continue; }
    if ((m = line.match(/^-:\s*(.*)$/))) { distractors.push(m[1]); continue; }
    if ((m = line.match(/^([a-zA-Z_][\w-]*):\s*(.+)$/))) {
      const k = m[1], v = m[2].trim();
      if (k === "id") card.id = v;
      else if (k === "mode") card.mode = v;
      else if (k === "hint") card.hint = v;
      else if (k === "tags") card.tags = v.split(",").map(s => s.trim()).filter(Boolean);
      else cloze[k] = v;  // mode-specific (cloze answers, etc.)
      continue;
    }
    promptLines.push(line);
  }

  const prompt = promptLines.join("\n").trim();
  if (!card.mode) throw new Error(`Card missing 'mode': ${prompt.slice(0, 60)}`);

  if (card.mode === "typed") {
    card.prompt = prompt;
    card.answers = answers;
    card.fuzzy = { max_edit_distance: 2, case_sensitive: false };
  } else if (card.mode === "mc") {
    card.prompt = prompt;
    card.distractors = distractors;
    card.shuffle = true;
  } else if (card.mode === "cloze") {
    card.text = prompt;
    card.acceptable = {};
    // Cloze keys are the keys in {{...}}; the parser collected them as
    // generic key: value pairs into `cloze`. Pull each one back out.
    const keys = [...prompt.matchAll(/\{\{([^}]+)\}\}/g)].map(x => x[1]);
    for (const k of keys) {
      const v = cloze[k];
      if (!v) throw new Error(`Cloze card missing answer for key '${k}'`);
      card.acceptable[k] = [v];
    }
    card.fuzzy = { max_edit_distance: 1, case_sensitive: false };
  } else {
    throw new Error(`Unknown mode: ${card.mode}`);
  }
  return card;
}
