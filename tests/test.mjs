// Run with: node tests/test.mjs
import { newCardState, updateSM2, isMastered, isDue, buildSession, today } from "../runtime/sm2.js";
import { gradeAnswer } from "../runtime/grader.js";
import { computeScore } from "../runtime/scoring.js";
import { encodeState, decodeState, byteSize, SCHEMA_VERSION } from "../runtime/persistence.js";
import assert from "node:assert/strict";

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n   ${e.message}`); failed++; }
};

const sm2 = { starting_ease: 2.5, min_ease: 1.3, lapse_interval_days: 1 };

const SETTINGS = {
  course: "TEST",
  schedule: { duration_weeks: 5, target_active_days_per_week: 4,
              daily_new_card_limit: 25, daily_review_limit: 150 },
  scoring: { pass_threshold: 0.7, engagement_floor: 0.6,
             mastery_requires: { correct_count: 3, min_interval_days: 5 } },
  engagement: { weights: { consistency: 0.5, volume: 0.3, on_schedule: 0.2 },
                min_session_minutes_for_active_day: 5,
                min_latency_ms_for_productive_review: 800,
                desired_passes_per_card: 3 },
  sm2
};

/* ---- SM-2 ---- */

test("new card starts at ease 2.5 and is due immediately", () => {
  const s = newCardState("c1");
  assert.equal(s.ease, 2.5);
  assert.equal(s.repetitions, 0);
  assert.ok(isDue(s));
});

test("correct quality 5 grows interval through 1, 6, then *ease", () => {
  const s = newCardState("c1");
  updateSM2(s, 5, sm2);
  assert.equal(s.interval_days, 1);
  updateSM2(s, 5, sm2);
  assert.equal(s.interval_days, 6);
  updateSM2(s, 5, sm2);
  assert.ok(s.interval_days >= 15);  // 6 * ~2.6
});

test("quality < 3 lapses card to interval 1 and resets repetitions", () => {
  const s = newCardState("c1");
  updateSM2(s, 5, sm2);
  updateSM2(s, 5, sm2);
  updateSM2(s, 1, sm2);  // lapse
  assert.equal(s.repetitions, 0);
  assert.equal(s.interval_days, 1);
  assert.equal(s.lapses, 1);
});

test("ease has a floor of 1.3", () => {
  const s = newCardState("c1");
  for (let i = 0; i < 20; i++) updateSM2(s, 1, sm2);
  assert.ok(s.ease >= 1.3);
});

test("isMastered requires both correct_count and interval", () => {
  const s = newCardState("c1");
  updateSM2(s, 5, sm2); updateSM2(s, 5, sm2); updateSM2(s, 5, sm2);
  assert.ok(isMastered(s, { correct_count: 3, min_interval_days: 5 }));
  assert.ok(!isMastered(s, { correct_count: 5, min_interval_days: 5 }));
});

/* ---- Grader ---- */

test("typed: exact match → quality 5 when fast enough", () => {
  const card = { mode: "typed", answers: ["valid"], fuzzy: { max_edit_distance: 2 } };
  const r = gradeAnswer(card, "valid", 1500, SETTINGS);
  assert.equal(r.correct, true);
  assert.equal(r.quality, 5);
});

test("typed: typo within tolerance still correct, quality 4 if slow", () => {
  const card = { mode: "typed", answers: ["valid"], fuzzy: { max_edit_distance: 2 } };
  const r = gradeAnswer(card, "valdi", 400, SETTINGS);  // 2 edits, fast = not productive
  assert.equal(r.correct, true);
  assert.equal(r.quality, 4);
});

test("typed: way off → close vs wrong", () => {
  const card = { mode: "typed", answers: ["modus ponens"], fuzzy: { max_edit_distance: 2 } };
  assert.equal(gradeAnswer(card, "wombat", 2000, SETTINGS).quality, 1);
  assert.equal(gradeAnswer(card, "modus poens", 2000, SETTINGS).correct, true);
});

test("mc: matches `correct` exactly", () => {
  const card = { mode: "mc", correct: "ad hominem", distractors: ["x", "y"] };
  assert.equal(gradeAnswer(card, "ad hominem", 2000, SETTINGS).correct, true);
  assert.equal(gradeAnswer(card, "x", 2000, SETTINGS).correct, false);
});

test("cloze: all keys must match", () => {
  const card = {
    mode: "cloze",
    text: "An argument is {{sound}} when ...",
    acceptable: { sound: ["sound"] },
    fuzzy: { max_edit_distance: 1 }
  };
  assert.equal(gradeAnswer(card, { sound: "sound" }, 2000, SETTINGS).correct, true);
  assert.equal(gradeAnswer(card, { sound: "valid" }, 2000, SETTINGS).correct, false);
});

/* ---- Scoring formula ---- */

test("score is 0 when nothing attempted", () => {
  const deck = [{ id: "a" }, { id: "b" }];
  const stateMap = { a: newCardState("a"), b: newCardState("b") };
  const activity = { active_days: [], productive_reviews: 0, on_schedule_reviews: 0, due_reviews_offered: 1 };
  const s = computeScore(deck, stateMap, activity, SETTINGS);
  assert.equal(s.final, 0);
  assert.equal(s.mastery, 0);
});

test("perfect mastery + zero engagement → score = floor * mastery", () => {
  const deck = [{ id: "a" }];
  const stateMap = { a: newCardState("a") };
  updateSM2(stateMap.a, 5, sm2);
  updateSM2(stateMap.a, 5, sm2);
  updateSM2(stateMap.a, 5, sm2);
  const activity = { active_days: [], productive_reviews: 0, on_schedule_reviews: 0, due_reviews_offered: 1 };
  const s = computeScore(deck, stateMap, activity, SETTINGS);
  // mastery=1, completion=1 (3 attempts, 3 correct), engagement=0
  // final = 1 * (0.6 + 0.4*0) * 1 = 0.6
  assert.equal(Math.round(s.final * 100), 60);
});

test("partial mastery still scales by engagement floor", () => {
  const deck = [{ id: "a" }, { id: "b" }];
  const stateMap = { a: newCardState("a"), b: newCardState("b") };
  for (let i = 0; i < 3; i++) updateSM2(stateMap.a, 5, sm2);
  // b: only 1 correct attempt → not mastered, but seriously attempted? Needs attempts>=2.
  updateSM2(stateMap.b, 5, sm2);
  updateSM2(stateMap.b, 5, sm2);  // attempts=2, correct=2, but not enough interval yet for mastery
  const activity = { active_days: ["2026-05-28","2026-05-29","2026-05-30","2026-05-31"],
                     productive_reviews: 6, on_schedule_reviews: 0, due_reviews_offered: 1 };
  const s = computeScore(deck, stateMap, activity, SETTINGS);
  assert.ok(s.final > 0 && s.final < 1);
});

/* ---- Session building ---- */

test("buildSession respects daily caps", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` }));
  const stateMap = {};
  for (const c of cards) stateMap[c.id] = newCardState(c.id);
  const sess = buildSession(cards, stateMap, SETTINGS, { new: 0, reviews: 0 });
  assert.equal(sess.new.length, 25);  // capped at daily_new_card_limit
});

/* ---- Persistence ---- */

test("encode skips unattempted cards (lazy init)", () => {
  const sm = { a: newCardState("a"), b: newCardState("b") };
  updateSM2(sm.a, 5, sm2);
  const enc = encodeState(sm, { intro_seen: true, daily_counts: {} });
  assert.ok(enc.s.a);
  assert.equal(enc.s.b, undefined);
});

test("encode uses short keys", () => {
  const sm = { a: newCardState("a") };
  updateSM2(sm.a, 5, sm2);
  const enc = encodeState(sm, { intro_seen: false, daily_counts: {} });
  assert.deepEqual(Object.keys(enc.s.a).sort(), ["a","c","d","e","i","l","r"]);
});

test("encode/decode round-trips state", () => {
  const cards = [{ id: "a" }, { id: "b" }];
  const sm = { a: newCardState("a"), b: newCardState("b") };
  updateSM2(sm.a, 5, sm2); updateSM2(sm.a, 5, sm2);
  const enc = encodeState(sm, { intro_seen: true, daily_counts: {}, productive_reviews: 4 });
  const { stateMap: rest, activity: ract } = decodeState(enc, cards, 2.5);
  assert.equal(rest.a.attempts, 2);
  assert.equal(rest.a.correct_count, 2);
  assert.equal(rest.b.attempts, 0);  // lazy-init default
  assert.equal(ract.intro_seen, true);
  assert.equal(ract.productive_reviews, 4);
});

test("decode treats unknown schema as fresh start", () => {
  const cards = [{ id: "a" }];
  const { stateMap, activity, migrated } = decodeState({ v: 99, s: {} }, cards, 2.5);
  assert.equal(migrated, true);
  assert.equal(stateMap.a.attempts, 0);
  assert.equal(activity.intro_seen, false);
});

test("encoded blob is dramatically smaller than legacy shape", () => {
  // 200 attempted cards
  const cards = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}` }));
  const sm = {};
  for (const c of cards) {
    sm[c.id] = newCardState(c.id);
    updateSM2(sm[c.id], 5, sm2);
    updateSM2(sm[c.id], 5, sm2);
    updateSM2(sm[c.id], 5, sm2);
  }
  const enc = encodeState(sm, { intro_seen: true, daily_counts: {} });
  const size = byteSize(enc);
  // Comfortably under 64KB (SCORM 2004) and within reach of 4KB (1.2 needs harder squeeze).
  assert.ok(size < 20_000, `expected < 20KB, got ${size}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
