import { newCardState, updateSM2, buildSession, buildStudyAhead, isMastered, today } from "./sm2.js";
import { gradeAnswer } from "./grader.js";
import { computeScore } from "./scoring.js";
import { encodeState, decodeState, byteSize, SIZE_WARN_BYTES_2004 } from "./persistence.js";

const $ = (sel) => document.querySelector(sel);
const todayKey = () => today();   // integer day number
const NEXT_DELAY_MS = 1200;

let deck, settings;
let stateMap = {};
let activity = null;

let session = null;
let studyAheadQueue = null;       // non-null when in study-ahead mode
let currentCard = null;
let currentIsNew = false;
let cardShownAt = 0;
let sessionStartedAt = 0;
let sessionStreak = 0;
let lastFocusBeforeModal = null;

async function main() {
  SCORM.init();
  [deck, settings] = await Promise.all([
    fetch("./cards.json").then(r => r.json()).then(j => j.deck),
    fetch("./class_settings.json").then(r => r.json())
  ]);
  $("#deck-title").textContent = deck.title;
  $("#course-tag").textContent = settings.course;

  hydrate();
  wireIntro();
  refreshStats();

  if (!activity.intro_seen) showIntro();
  else startSession();

  $("#submit-btn").addEventListener("click", onSubmit);
  $("#next-btn").addEventListener("click", showNextCard);
  $("#study-ahead-btn").addEventListener("click", enterStudyAhead);
  $("#reset-btn").addEventListener("click", resetProgress);
  $("#show-intro").addEventListener("click", () => showIntro());

  document.addEventListener("keydown", onGlobalKey);
  window.addEventListener("beforeunload", commit);
  setInterval(commit, 30_000);
}

function hydrate() {
  const blob = SCORM.getSuspendData();
  const decoded = decodeState(blob, deck.cards, settings.sm2.starting_ease);
  stateMap = decoded.stateMap;
  activity = decoded.activity;
  if (decoded.migrated) console.warn("suspend_data schema mismatch — starting fresh");
}

/* ---------- Intro ---------- */

function wireIntro() {
  const screens = document.querySelectorAll(".intro-screen");
  const dots = document.querySelectorAll(".intro-dots .dot");
  const nextBtn = $("#intro-next");
  const skipBtn = $("#intro-skip");
  let idx = 0;
  const show = (i) => {
    screens.forEach((s, k) => s.hidden = k !== i);
    dots.forEach((d, k) => d.classList.toggle("active", k === i));
    nextBtn.textContent = i === screens.length - 1 ? "Start studying" : "Next";
  };
  nextBtn.addEventListener("click", () => {
    if (idx < screens.length - 1) { idx++; show(idx); }
    else dismissIntro();
  });
  skipBtn.addEventListener("click", dismissIntro);
  $("#show-intro").addEventListener("click", () => { idx = 0; show(0); });
  show(0);
}

function showIntro() {
  lastFocusBeforeModal = document.activeElement;
  $("#intro").hidden = false;
  // Focus the primary action so keyboard users can advance immediately.
  setTimeout(() => $("#intro-next").focus(), 0);
}

function dismissIntro() {
  $("#intro").hidden = true;
  const wasFirstTime = !activity.intro_seen;
  activity.intro_seen = true;
  commit();
  if (lastFocusBeforeModal && lastFocusBeforeModal.focus) lastFocusBeforeModal.focus();
  if (wasFirstTime) startSession();
}

function onGlobalKey(e) {
  const introOpen = !$("#intro").hidden;
  if (introOpen) {
    if (e.key === "Escape") dismissIntro();
    if (e.key === "Tab") trapFocus(e, $("#intro"));
    return;
  }
  if (e.key === "Enter") {
    if (!$("#submit-btn").hidden) onSubmit();
    else if (!$("#next-btn").hidden && !$("#next-btn").disabled) showNextCard();
  }
}

function trapFocus(e, container) {
  const focusables = container.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])");
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------- Session ---------- */

function startSession() {
  sessionStartedAt = Date.now();
  sessionStreak = 0;
  studyAheadQueue = null;
  updateStreakDisplay();
  const today = todayKey();
  const todayCounts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0 };
  session = buildSession(deck.cards, stateMap, settings, todayCounts);
  activity.due_reviews_offered += session.reviews.length;
  $("#study-mode-banner").hidden = true;
  showNextCard();
}

function showNextCard() {
  if (studyAheadQueue) {
    if (studyAheadQueue.length === 0) { renderStudyAheadDone(); return; }
    currentCard = studyAheadQueue.shift();
    currentIsNew = false;
  } else {
    const reviews = session.reviews;
    const fresh = session.new;
    if (reviews.length === 0 && fresh.length === 0) { renderDone(); return; }
    const pickReview = reviews.length > 0 && (fresh.length === 0 || Math.random() < 0.8);
    currentCard = pickReview ? reviews.shift() : fresh.shift();
    currentIsNew = !pickReview;
  }
  renderCard(currentCard);
  cardShownAt = Date.now();
}

function renderCard(card) {
  const fb = $("#feedback");
  fb.textContent = ""; fb.className = "feedback";
  $("#next-btn").hidden = true;
  $("#next-btn").disabled = true;
  $("#submit-btn").hidden = false;
  $("#study-ahead-btn").hidden = true;
  $("#card").classList.remove("flash-ok", "flash-bad");

  const body = $("#card-body");
  body.innerHTML = "";

  if (card.mode === "typed") {
    body.innerHTML = `
      <p class="prompt">${escapeHtml(card.prompt)}</p>
      <label class="visually-hidden" for="answer-input">Your answer</label>
      <input id="answer-input" type="text" autocomplete="off" autofocus aria-label="Your answer" />
    `;
  } else if (card.mode === "cloze") {
    const parts = card.text.split(/(\{\{[^}]+\}\})/g);
    const html = parts.map(p => {
      const m = p.match(/^\{\{([^}]+)\}\}$/);
      if (!m) return escapeHtml(p);
      return `<input class="cloze-input" data-key="${m[1]}" type="text" autocomplete="off" aria-label="Fill in ${escapeAttr(m[1])}" />`;
    }).join("");
    body.innerHTML = `<p class="prompt">${html}</p>`;
  } else if (card.mode === "mc") {
    const options = [card.correct, ...card.distractors];
    if (card.shuffle !== false) shuffle(options);
    body.innerHTML = `
      <p class="prompt" id="mc-prompt">${escapeHtml(card.prompt)}</p>
      <div class="choices" role="radiogroup" aria-labelledby="mc-prompt">
        ${options.map(o =>
          `<label data-value="${escapeAttr(o)}"><input type="radio" name="mc" value="${escapeAttr(o)}"> ${escapeHtml(o)}</label>`
        ).join("")}
      </div>
    `;
  }
  const first = body.querySelector("input");
  if (first) first.focus();
}

function readResponse(card) {
  if (card.mode === "typed") return document.querySelector("#answer-input")?.value ?? "";
  if (card.mode === "mc") {
    const r = document.querySelector('input[name="mc"]:checked');
    return r ? r.value : "";
  }
  if (card.mode === "cloze") {
    const out = {};
    document.querySelectorAll(".cloze-input").forEach(el => out[el.dataset.key] = el.value);
    return out;
  }
}

function onSubmit() {
  if (!currentCard) return;
  const latency = Date.now() - cardShownAt;
  const response = readResponse(currentCard);
  const result = gradeAnswer(currentCard, response, latency, settings);
  const { correct } = result;

  // In study-ahead, never mutate SM-2 state or any grade-affecting counters.
  if (!studyAheadQueue) {
    updateSM2(stateMap[currentCard.id], result.quality, settings.sm2);
    const today = todayKey();
    const counts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0, practiced: 0, correct: 0 };
    if (currentIsNew) counts.new += 1; else counts.reviews += 1;
    counts.practiced = (counts.practiced || 0) + 1;
    if (correct) counts.correct = (counts.correct || 0) + 1;
    activity.daily_counts[today] = counts;
    if (result.productive && correct) activity.productive_reviews += 1;
    if (!currentIsNew && correct) activity.on_schedule_reviews += 1;
  }

  renderFeedback(currentCard, response, result);
  flashCard(correct);
  updateStreak(correct);
  lockoutNext();
  recordSessionMinutes();
  refreshStats();
  commit();
}

function renderFeedback(card, response, { correct, quality, perBlank }) {
  const fb = $("#feedback");
  if (correct) {
    fb.className = "feedback ok";
    fb.textContent = `✓ Correct${quality === 5 ? " — quick recall!" : ""}`;
    return;
  }
  fb.className = "feedback bad";
  const close = quality === 2;
  let html = close
    ? `<div class="close-note">So close — looks like a small slip.</div>`
    : `<div>Not quite.</div>`;

  if (card.mode === "typed") {
    html += `
      <div class="answer-compare">
        <span class="label">Your answer:</span><span class="yours">${escapeHtml(response || "(blank)")}</span>
        <span class="label">Answer:</span><span class="truth">${escapeHtml(card.answers[0])}</span>
      </div>`;
  } else if (card.mode === "cloze") {
    // Color each blank input by its per-blank result.
    if (perBlank) {
      document.querySelectorAll(".cloze-input").forEach(el => {
        const r = perBlank[el.dataset.key];
        if (!r) return;
        el.classList.add(r.correct ? "blank-ok" : (r.close ? "blank-close" : "blank-bad"));
        el.disabled = true;
      });
    }
    const wrongKeys = Object.entries(perBlank || {})
      .filter(([, v]) => !v.correct).map(([k]) => k);
    const rows = wrongKeys.map(k => `
        <span class="label">${escapeHtml(k)}:</span>
        <span class="yours">${escapeHtml(response?.[k] || "(blank)")}</span>
        <span class="label"></span>
        <span class="truth">${escapeHtml(card.acceptable[k][0])}</span>`).join("");
    html += `<div class="answer-compare">${rows}</div>`;
  } else if (card.mode === "mc") {
    document.querySelectorAll(".choices label").forEach(lab => {
      const v = lab.dataset.value;
      if (v === card.correct) lab.classList.add("reveal-correct");
      else if (v === response) lab.classList.add("reveal-wrong");
      lab.querySelector("input").disabled = true;
    });
    html += `<div class="answer-compare">
      <span class="label">Answer:</span><span class="truth">${escapeHtml(card.correct)}</span>
    </div>`;
  }
  if (card.hint) html += `<div class="hint">💡 ${escapeHtml(card.hint)}</div>`;
  fb.innerHTML = html;
}

function flashCard(correct) {
  const el = $("#card");
  el.classList.remove("flash-ok", "flash-bad");
  void el.offsetWidth;
  el.classList.add(correct ? "flash-ok" : "flash-bad");
}

function updateStreak(correct) {
  if (correct) {
    sessionStreak += 1;
    const el = $("#streak");
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  } else sessionStreak = 0;
  updateStreakDisplay();
}

function updateStreakDisplay() { $("#streak-count").textContent = sessionStreak; }

function lockoutNext() {
  const submit = $("#submit-btn");
  const next = $("#next-btn");
  submit.hidden = true;
  next.hidden = false;
  next.disabled = true;
  next.textContent = "…";
  setTimeout(() => {
    next.disabled = false;
    next.textContent = "Next";
    next.focus();
  }, NEXT_DELAY_MS);
}

function recordSessionMinutes() {
  if (studyAheadQueue) return;  // study-ahead doesn't count toward engagement
  const now = Date.now();
  const minutesThisTick = Math.min(2, (now - sessionStartedAt) / 60000);
  sessionStartedAt = now;
  const today = todayKey();
  const counts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0 };
  counts.minutes += minutesThisTick;
  activity.daily_counts[today] = counts;
  if (counts.minutes >= settings.engagement.min_session_minutes_for_active_day
      && !activity.active_days.includes(today)) {
    activity.active_days.push(today);
  }
}

/* ---------- Study-ahead ---------- */

function enterStudyAhead() {
  const queue = buildStudyAhead(deck.cards, stateMap);
  if (!queue.length) return;
  studyAheadQueue = queue;
  $("#study-mode-banner").hidden = false;
  showNextCard();
}

function renderStudyAheadDone() {
  $("#card-body").innerHTML = `<p class="prompt">No more cards to preview. Nice work.</p>`;
  $("#submit-btn").hidden = true;
  $("#next-btn").hidden = true;
  $("#study-ahead-btn").hidden = true;
}

function renderDone() {
  const ahead = buildStudyAhead(deck.cards, stateMap);
  $("#card-body").innerHTML = `
    <p class="prompt">🎉 No more cards due today.</p>
    <p style="color: var(--muted);">Come back tomorrow — your engagement score rewards studying across days, not cramming in one.</p>
  `;
  $("#submit-btn").hidden = true;
  $("#next-btn").hidden = true;
  $("#study-ahead-btn").hidden = ahead.length === 0;
  $("#study-ahead-btn").textContent = `Study ahead (${ahead.length} cards)`;
}

/* ---------- Reset ---------- */

function resetProgress() {
  const ok = confirm(
    "Reset all progress?\n\n" +
    "This will erase your card states, daily activity, and streak. " +
    "Your D2L score will reset to 0. This can't be undone."
  );
  if (!ok) return;
  stateMap = {};
  for (const card of deck.cards) {
    stateMap[card.id] = newCardState(card.id, settings.sm2.starting_ease);
  }
  activity = {
    first_launch_day: today(),
    intro_seen: true,
    active_days: [],
    productive_reviews: 0,
    on_schedule_reviews: 0,
    due_reviews_offered: 0,
    daily_counts: {}
  };
  commit();
  refreshStats();
  startSession();
}

/* ---------- Stats / persistence ---------- */

function refreshStats() {
  const score = computeScore(deck.cards, stateMap, activity, settings);
  const today = todayKey();
  const counts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0, practiced: 0, correct: 0 };

  // Today panel — the immediate feedback.
  const practiced = counts.practiced || 0;
  const correct = counts.correct || 0;
  $("#today-practiced").textContent = practiced;
  $("#today-correct").textContent = `${correct} correct`;
  $("#today-accuracy").textContent = practiced
    ? `${Math.round(100 * correct / practiced)}% accuracy`
    : "—";

  // Daily caps.
  $("#stat-new").textContent = `${counts.new} / ${settings.schedule.daily_new_card_limit}`;
  $("#stat-reviews").textContent = `${counts.reviews} / ${settings.schedule.daily_review_limit}`;

  // Long-term progress.
  $("#stat-mastery").textContent = `${score.mastered_count}/${score.total_cards}`;
  $("#stat-engagement").textContent = (score.engagement * 100).toFixed(0) + "%";
  $("#stat-completion").textContent = (score.completion * 100).toFixed(0) + "%";

  // Score display: narrative for new learners, number once it's meaningful.
  const scoreIsMeaningful = score.mastered_count >= 1 || score.completion >= 0.2;
  const scoreEl = $("#stat-final");
  const narrEl = $("#score-narrative");
  if (scoreIsMeaningful) {
    scoreEl.textContent = (score.final * 100).toFixed(1);
    scoreEl.style.color = "";
    narrEl.hidden = true;
  } else {
    scoreEl.textContent = "—";
    scoreEl.style.color = "var(--muted)";
    narrEl.hidden = false;
    narrEl.textContent = practiced === 0
      ? "Your gradebook score builds as you master cards across multiple days."
      : "Nice start. Your gradebook score appears once you've returned to confirm what you've learned.";
  }

  // Two-tier progress bar: lighter fill for cards started, darker for continuous mastery progress.
  $("#started-fill").style.width = (score.startedFraction * 100).toFixed(1) + "%";
  $("#mastery-fill").style.width = (score.masteryProgress * 100).toFixed(1) + "%";
  $("#mastery-bar").setAttribute("aria-valuenow", Math.round(score.masteryProgress * 100));

  // LMS: always send the honest score, regardless of what the UI shows.
  SCORM.setScore(score.final);
  SCORM.setProgress(score.completion);
  SCORM.setSuccess(score.final >= settings.scoring.pass_threshold ? "passed" : "unknown");
  SCORM.setCompletion(score.completion >= 0.95 ? "completed" : "incomplete");
}

function commit() {
  const encoded = encodeState(stateMap, activity);
  const size = byteSize(encoded);
  if (size > SIZE_WARN_BYTES_2004) {
    console.warn(`suspend_data is ${size} bytes — approaching SCORM 2004's 64KB cap.`);
  }
  SCORM.setSuspendData(encoded);
  SCORM.commit();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

window.addEventListener("DOMContentLoaded", main);
window.addEventListener("pagehide", () => { commit(); SCORM.terminate(); });
