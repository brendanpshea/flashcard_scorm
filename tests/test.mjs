// Run with: node tests/test.mjs
import { newCardState, updateSM2, isMastered, isDue, buildSession, today, configureDayBoundary, MS_PER_DAY } from "../runtime/sm2.js";
import { gradeAnswer } from "../runtime/grader.js";
import { computeScore, resolveTargetActiveDays, creditDueOffered, totalDueOffered, dayStreak } from "../runtime/scoring.js";
import { DEFAULT_SETTINGS, mergeSettings } from "../runtime/defaults.js";
import { encodeState, decodeState, byteSize, SCHEMA_VERSION } from "../runtime/persistence.js";
import { createSessionState, nextSessionCard, recordSessionAnswer } from "../runtime/session.js";
import assert from "node:assert/strict";

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n   ${e.message}`); failed++; }
};

const sm2 = { starting_ease: 2.5, min_ease: 1.3, lapse_interval_days: 1 };

const SETTINGS = {
  course: "TEST",
  schedule: { daily_new_card_limit: 25, daily_review_limit: 150 },
  scoring: { pass_threshold: 0.7, engagement_floor: 0.6,
             mastery_requires: { correct_count: 3 } },
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

test("isMastered after 3 corrects; lapse drops mastery", () => {
  const s = newCardState("c1");
  updateSM2(s, 5, sm2); updateSM2(s, 5, sm2); updateSM2(s, 5, sm2);
  assert.ok(isMastered(s, { correct_count: 3 }));
  assert.ok(!isMastered(s, { correct_count: 5 }));
  // Lapse: correct_count stays high, but repetitions resets → not mastered.
  updateSM2(s, 1, sm2);
  assert.ok(!isMastered(s, { correct_count: 3 }));
  // Recover with one correct → mastered again.
  updateSM2(s, 5, sm2);
  assert.ok(isMastered(s, { correct_count: 3 }));
});

test("isMastered honors optional min_interval_days gate", () => {
  const s = newCardState("c1");
  updateSM2(s, 5, sm2);  // interval 1
  updateSM2(s, 5, sm2);  // interval 6
  // correct_count=2 here; bump to 3 corrects to clear the count requirement.
  updateSM2(s, 5, sm2);  // interval ~15
  assert.ok(isMastered(s, { correct_count: 3, min_interval_days: 5 }));   // 15 >= 5
  assert.ok(!isMastered(s, { correct_count: 3, min_interval_days: 30 }));  // 15 < 30
  // A card with enough corrects but a short interval is gated out.
  const t = newCardState("c2");
  updateSM2(t, 5, sm2); updateSM2(t, 1, sm2); updateSM2(t, 5, sm2);  // lapsed then 1 correct → interval 1, reps 1, correct 2
  assert.ok(!isMastered(t, { correct_count: 2, min_interval_days: 5 }));  // interval 1 < 5
});

test("day boundary: utc mode matches raw UTC day; local mode applies offset", () => {
  configureDayBoundary("utc");
  assert.equal(today(), Math.floor(Date.now() / MS_PER_DAY));
  configureDayBoundary("local");
  const off = new Date().getTimezoneOffset() * 60000;
  assert.equal(today(), Math.floor((Date.now() - off) / MS_PER_DAY));
  // local and utc differ by at most one day number.
  configureDayBoundary("utc"); const u = today();
  configureDayBoundary("local"); const l = today();
  assert.ok(Math.abs(u - l) <= 1);
  configureDayBoundary("local");  // restore default for later tests
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

test("close band: near-miss on a long word reads as close (quality 2)", () => {
  const card = { mode: "typed", answers: ["modus ponens"], fuzzy: { max_edit_distance: 2 } };
  // "modus ponxxx": 3 edits — past tolerance but small relative to a 12-char word.
  const r = gradeAnswer(card, "modus ponxxx", 2000, SETTINGS);
  assert.equal(r.correct, false);
  assert.equal(r.quality, 2);
});

test("close band: a different short word is NOT close (quality 1)", () => {
  const card = { mode: "typed", answers: ["cat"], fuzzy: { max_edit_distance: 2 } };
  // "dogs" is edit distance 4 — the old tol+2 rule called this "close"; it isn't.
  const r = gradeAnswer(card, "dogs", 2000, SETTINGS);
  assert.equal(r.correct, false);
  assert.equal(r.quality, 1);
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

test("completion is not a grade factor (same mastery+engagement → same score)", () => {
  // Both decks: 2 cards, card a mastered (mastery=0.5), zero engagement.
  // They differ only in completion — which must not move the grade.
  const mkA = () => { const s = newCardState("a"); for (let i=0;i<3;i++) updateSM2(s,5,sm2); return s; };
  const activity = { active_days: [], productive_reviews: 0, on_schedule_reviews: 0, due_offered_by_day: {} };

  // b untouched → completion = 0.5
  const low = computeScore([{id:"a"},{id:"b"}], { a: mkA(), b: newCardState("b") }, activity, SETTINGS);
  // b seriously attempted but not mastered → completion = 1.0
  const bAttempted = newCardState("b"); updateSM2(bAttempted,5,sm2); updateSM2(bAttempted,1,sm2);
  const high = computeScore([{id:"a"},{id:"b"}], { a: mkA(), b: bAttempted }, activity, SETTINGS);

  assert.ok(low.completion < high.completion);   // completion really does differ
  assert.equal(low.mastery, high.mastery);
  assert.equal(low.final, high.final);            // ...but the grade does not
  assert.equal(Math.round(low.final * 100), 30);  // 0.5 mastery * 0.6 floor
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

/* ---- Day streak ---- */

test("dayStreak counts consecutive days up to today", () => {
  assert.equal(dayStreak([], 100), 0);
  assert.equal(dayStreak([100], 100), 1);
  assert.equal(dayStreak([98, 99, 100], 100), 3);
  // Out-of-order input still works.
  assert.equal(dayStreak([100, 98, 99], 100), 3);
});

test("dayStreak stays alive on a not-yet-active today, breaks after a gap", () => {
  // Studied through yesterday but not yet today → streak still counts (alive).
  assert.equal(dayStreak([97, 98, 99], 100), 3);
  // Missed yesterday entirely → broken.
  assert.equal(dayStreak([95, 96, 97], 100), 0);
  // A gap only counts the run ending at the anchor.
  assert.equal(dayStreak([90, 91, 99, 100], 100), 2);
});

/* ---- Engagement: due-offered accounting (relaunch stability) ---- */

test("creditDueOffered keeps the per-day max, idempotent across relaunches", () => {
  let m = {};
  m = creditDueOffered(m, 100, 8);   // first open today: 8 due
  assert.equal(m[100], 8);
  m = creditDueOffered(m, 100, 5);   // reopen later: 3 already done, 5 remain
  assert.equal(m[100], 8);           // must NOT grow — same work, not new work
  m = creditDueOffered(m, 100, 12);  // more cards fell due today
  assert.equal(m[100], 12);          // grows to the real total
  m = creditDueOffered(m, 101, 4);   // next day accumulates separately
  assert.equal(totalDueOffered({ due_offered_by_day: m }), 16);
});

test("creditDueOffered does not mutate its input", () => {
  const m = { 100: 8 };
  const out = creditDueOffered(m, 100, 12);
  assert.equal(m[100], 8);
  assert.equal(out[100], 12);
});

test("relaunching the same day does not lower the on-schedule denominator", () => {
  const deck = [{ id: "a" }];
  const stateMap = { a: newCardState("a") };
  for (let i = 0; i < 3; i++) updateSM2(stateMap.a, 5, sm2);
  const base = { active_days: ["d1"], productive_reviews: 3, on_schedule_reviews: 3 };
  // Naive accumulation would sum 8 + 5 = 13; per-day max keeps it at 8.
  let m = creditDueOffered({}, 100, 8);
  m = creditDueOffered(m, 100, 5);
  const s = computeScore(deck, stateMap, { ...base, due_offered_by_day: m }, SETTINGS);
  assert.equal(totalDueOffered({ due_offered_by_day: m }), 8);
  assert.ok(s.engagement > 0);
});

test("totalDueOffered falls back to legacy scalar when no per-day map", () => {
  assert.equal(totalDueOffered({ due_reviews_offered: 7 }), 7);
  assert.equal(totalDueOffered({ due_offered_by_day: {}, due_reviews_offered: 7 }), 7);
});

/* ---- Session building ---- */

test("mergeSettings: empty override returns defaults", () => {
  const merged = mergeSettings({});
  assert.equal(merged.scoring.pass_threshold, 0.7);
  assert.equal(merged.schedule.daily_new_card_limit, 20);
  assert.deepEqual(merged.engagement.weights, DEFAULT_SETTINGS.engagement.weights);
});

test("mergeSettings: override deep-merges without losing siblings", () => {
  const merged = mergeSettings({ schedule: { daily_new_card_limit: 35 } });
  assert.equal(merged.schedule.daily_new_card_limit, 35);
  assert.equal(merged.schedule.daily_review_limit, 100);  // default preserved
  assert.equal(merged.scoring.pass_threshold, 0.7);
});

test("target_active_days: derived from deck size when not set", () => {
  // 60 cards / 25 per day = 3 intro days, + 7 review tail = 10
  assert.equal(resolveTargetActiveDays(60, SETTINGS), 10);
  // 500 cards / 25 = 20 intro days, + 7 = 27
  assert.equal(resolveTargetActiveDays(500, SETTINGS), 27);
});

test("target_active_days: explicit value overrides derivation", () => {
  const s = { ...SETTINGS, schedule: { ...SETTINGS.schedule, target_active_days: 42 } };
  assert.equal(resolveTargetActiveDays(500, s), 42);
});

test("buildSession respects daily caps", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` }));
  const stateMap = {};
  for (const c of cards) stateMap[c.id] = newCardState(c.id);
  const sess = buildSession(cards, stateMap, SETTINGS, { new: 0, reviews: 0 });
  assert.equal(sess.new.length, 25);  // capped at daily_new_card_limit
});

test("session requeues misses to the tail until answered correctly once", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  const session = createSessionState({ reviews: [a], new: [b, c] }, () => 0);

  const first = nextSessionCard(session);
  assert.equal(first.id, "a");
  recordSessionAnswer(session, first, false);
  assert.deepEqual(session.queue.map(card => card.id), ["b", "c", "a"]);
  assert.equal(session.remainingIds.size, 3);

  const second = nextSessionCard(session);
  recordSessionAnswer(session, second, true);
  const third = nextSessionCard(session);
  recordSessionAnswer(session, third, true);
  const fourth = nextSessionCard(session);
  recordSessionAnswer(session, fourth, true);

  assert.equal(fourth.id, "a");
  assert.equal(session.remainingIds.size, 0);
  assert.equal(nextSessionCard(session), null);
});

test("missed new card becomes a review until it is answered correctly", () => {
  const a = { id: "a" };
  const session = createSessionState({ reviews: [], new: [a] }, () => 0);

  const first = nextSessionCard(session);
  const miss = recordSessionAnswer(session, first, false);
  assert.equal(miss.promotedToReview, true);
  assert.equal(session.kindById.a, "review");
  assert.equal(session.pendingReviewIds.size, 1);

  const retry = nextSessionCard(session);
  const ok = recordSessionAnswer(session, retry, true);
  assert.equal(ok.promotedToReview, false);
  assert.equal(session.pendingReviewIds.size, 0);
  assert.equal(session.remainingIds.size, 0);
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

test("due_offered_by_day round-trips; legacy scalar dr is ignored on decode", () => {
  const cards = [{ id: "a" }];
  const sm = { a: newCardState("a") };
  updateSM2(sm.a, 5, sm2);
  const enc = encodeState(sm, { intro_seen: true, daily_counts: {}, due_offered_by_day: { 100: 8, 101: 4 } });
  assert.deepEqual(enc.a.dr, { 100: 8, 101: 4 });
  const { activity } = decodeState(enc, cards, 2.5);
  assert.deepEqual(activity.due_offered_by_day, { 100: 8, 101: 4 });
  // A blob saved before the change stored dr as a number — must not crash.
  const legacy = { ...enc, a: { ...enc.a, dr: 13 } };
  const { activity: act2 } = decodeState(legacy, cards, 2.5);
  assert.deepEqual(act2.due_offered_by_day, {});
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
