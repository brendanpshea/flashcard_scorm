#!/usr/bin/env node
// Convert markdown deck file(s) to cards.json.
//
// Usage:
//   node tools/md2json.js <input.md> [--out <output.json>]
//   node tools/md2json.js <dir/>     [--out <output.json>]
//   node tools/md2json.js <a.md> <b.md> ... --out <output.json>
//
// With a directory, all *.md files inside are read in sorted order.
// Deck-level header (# Deck:, id:, version:) is taken from the first file
// that declares one. Card IDs must be unique across the merged deck.
//
// Per-card format:
//   ---
//   id: <card-id>            (optional; auto-generated if missing)
//   mode: typed|cloze|mc
//   tags: tag1, tag2
//   hint: <optional hint>
//   Q: <prompt or cloze text with {{key}}>
//
//   # typed:   A: <accepted>  (repeatable)
//   # cloze:   <key>: <accepted>  (one per cloze key)
//   # mc:      *: <correct>   -: <distractor>  (repeatable)

const fs = require("fs");
const path = require("path");

const { inputs, outPath } = parseArgs(process.argv.slice(2));
if (!inputs.length) {
  console.error("Usage: node tools/md2json.js <input.md|dir> [...] [--out <output.json>]");
  process.exit(1);
}

const files = expandInputs(inputs);
if (!files.length) {
  console.error(`No .md files found in: ${inputs.join(", ")}`);
  process.exit(1);
}

const deck = { id: "deck", title: "Untitled", version: 1, cards: [] };
let foundHeader = false;
const seen = new Set();
let autoIdCounter = 0;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const { header, cards } = parseFile(src, file);
  if (!foundHeader && header._explicit) {
    Object.assign(deck, { id: header.id, title: header.title, version: header.version });
    foundHeader = true;
  }
  for (const card of cards) {
    if (!card.id) card.id = `c${String(++autoIdCounter).padStart(3, "0")}`;
    else autoIdCounter = Math.max(autoIdCounter, parseAutoId(card.id));
    if (seen.has(card.id)) {
      throw new Error(`Duplicate card id "${card.id}" (second occurrence in ${file})`);
    }
    seen.add(card.id);
    deck.cards.push(card);
  }
}

const json = JSON.stringify({ deck }, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, json);
  console.log(`Wrote ${outPath} — ${deck.cards.length} cards from ${files.length} file(s).`);
} else {
  process.stdout.write(json + "\n");
}

/* ---------- arg / input handling ---------- */

function parseArgs(args) {
  const inputs = [];
  let outPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" || args[i] === "-o") outPath = args[++i];
    else inputs.push(args[i]);
  }
  return { inputs, outPath };
}

function expandInputs(inputs) {
  const out = [];
  for (const p of inputs) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) {
        if (f.endsWith(".md")) out.push(path.join(p, f));
      }
    } else out.push(p);
  }
  return out;
}

function parseAutoId(id) {
  const m = id.match(/^c(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/* ---------- parsing ---------- */

function parseFile(src, file) {
  const sections = src.split(/^---\s*$/m);
  const headerText = sections.shift();
  const header = parseHeader(headerText);
  const cards = [];
  sections.forEach((sec, idx) => {
    try {
      const card = parseCard(sec);
      if (card) cards.push(card);
    } catch (e) {
      throw new Error(`${file} card #${idx + 1}: ${e.message}`);
    }
  });
  return { header, cards };
}

function parseHeader(text) {
  const out = { id: "deck", title: "Untitled", version: 1, _explicit: false };
  for (const line of text.split(/\r?\n/)) {
    const titleMatch = line.match(/^#\s*Deck:\s*(.+)$/);
    if (titleMatch) { out.title = titleMatch[1].trim(); out._explicit = true; continue; }
    const kv = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (kv) {
      const [, k, v] = kv;
      if (k === "id") { out.id = v.trim(); out._explicit = true; }
      else if (k === "version") { out.version = Number(v.trim()); out._explicit = true; }
      else if (k === "title") { out.title = v.trim(); out._explicit = true; }
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
  const promptLines = [];

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
      else cloze[k] = v;
      continue;
    }
    promptLines.push(line);
  }

  const prompt = promptLines.join("\n").trim();
  if (!card.mode) throw new Error(`missing 'mode' (prompt: "${prompt.slice(0, 60)}")`);

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
    const keys = [...prompt.matchAll(/\{\{([^}]+)\}\}/g)].map(x => x[1]);
    for (const k of keys) {
      const v = cloze[k];
      if (!v) throw new Error(`cloze missing answer for key '${k}'`);
      card.acceptable[k] = [v];
    }
    card.fuzzy = { max_edit_distance: 1, case_sensitive: false };
  } else {
    throw new Error(`unknown mode: ${card.mode}`);
  }
  return card;
}
