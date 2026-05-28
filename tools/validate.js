#!/usr/bin/env node
// Validate a deck JSON. Exit code 1 on any error.
// Usage: node tools/validate.js <deck.json> [<deck2.json> ...]

const fs = require("fs");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node tools/validate.js <deck.json> [...]");
  process.exit(1);
}

let totalErrors = 0;
for (const file of files) {
  const errors = validate(file);
  if (errors.length) {
    console.error(`✗ ${file} — ${errors.length} issue(s):`);
    for (const e of errors) console.error(`  • ${e}`);
    totalErrors += errors.length;
  } else {
    console.log(`✓ ${file}`);
  }
}
process.exit(totalErrors ? 1 : 0);

function validate(file) {
  const errs = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return [`could not parse: ${e.message}`]; }

  const deck = data.deck;
  if (!deck) return ["missing top-level 'deck' object"];
  if (!deck.id) errs.push("deck.id required");
  if (!deck.title) errs.push("deck.title required");
  if (!Array.isArray(deck.cards) || !deck.cards.length) {
    errs.push("deck.cards must be a non-empty array");
    return errs;
  }

  const seen = new Set();
  const VALID_MODES = new Set(["typed", "cloze", "mc"]);
  deck.cards.forEach((c, i) => {
    const label = `card[${i}]${c.id ? ` (${c.id})` : ""}`;
    if (!c.id) errs.push(`${label}: missing id`);
    else if (seen.has(c.id)) errs.push(`${label}: duplicate id`);
    else seen.add(c.id);

    if (!VALID_MODES.has(c.mode)) {
      errs.push(`${label}: mode must be one of ${[...VALID_MODES].join("|")} (got ${c.mode})`);
      return;
    }

    if (c.mode === "typed") {
      if (!c.prompt) errs.push(`${label}: typed card missing prompt`);
      if (!Array.isArray(c.answers) || !c.answers.length)
        errs.push(`${label}: typed card needs at least one answer`);
    } else if (c.mode === "mc") {
      if (!c.prompt) errs.push(`${label}: mc card missing prompt`);
      if (!c.correct) errs.push(`${label}: mc card missing 'correct'`);
      if (!Array.isArray(c.distractors) || c.distractors.length < 2)
        errs.push(`${label}: mc card needs at least 2 distractors`);
      if (c.distractors?.includes(c.correct))
        errs.push(`${label}: distractor duplicates correct answer`);
    } else if (c.mode === "cloze") {
      if (!c.text) errs.push(`${label}: cloze card missing text`);
      const keys = [...(c.text || "").matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
      if (!keys.length) errs.push(`${label}: cloze text has no {{placeholders}}`);
      if (!c.acceptable || typeof c.acceptable !== "object")
        errs.push(`${label}: cloze card missing acceptable map`);
      else {
        for (const k of keys) {
          if (!Array.isArray(c.acceptable[k]) || !c.acceptable[k].length)
            errs.push(`${label}: cloze key '${k}' has no acceptable answers`);
        }
        for (const k of Object.keys(c.acceptable)) {
          if (!keys.includes(k))
            errs.push(`${label}: acceptable has key '${k}' not used in text`);
        }
      }
    }
  });

  return errs;
}
