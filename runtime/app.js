import { newCardState, updateSM2, buildSession, isMastered } from "./sm2.js";
import { gradeAnswer } from "./grader.js";
import { computeScore } from "./scoring.js";

const $ = (sel) => document.querySelector(sel);
const todayKey = () => new Date().toISOString().slice(0, 10);
const NEXT_DELAY_MS = 1200;

let deck, settings;
let stateMap = {};
let activity = {
  first_launch: null,
  intro_seen: false,
  active_days: [],
  productive_reviews: 0,
  on_schedule_reviews: 0,
  due_reviews_offered: 0,
  daily_counts: {}
};

let session = null;
let currentCard = null;
let currentIsNew = false;
let cardShownAt = 0;
let sessionStartedAt = 0;
let sessionStreak = 0;

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
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!$("#intro").hidden) return;
    if (!$("#submit-btn").hidden) onSubmit();
    else if (!$("#next-btn").hidden && !$("#next-btn").disabled) showNextCard();
  });
  $("#show-intro").addEventListener("click", () => showIntro(true));
  window.addEventListener("beforeunload", commit);
  setInterval(commit, 30_000);
}

function hydrate() {
  const blob = SCORM.getSuspendData();
  if (blob && blob.stateMap) {
    stateMap = blob.stateMap;
    activity = Object.assign(activity, blob.activity || {});
  }
  if (!activity.first_launch) activity.first_launch = new Date().toISOString();
  for (const card of deck.cards) {
    if (!stateMap[card.id]) {
      stateMap[card.id] = newCardState(card.id, settings.sm2.starting_ease);
    }
  }
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
  // Reset to first screen each time intro is opened.
  $("#show-intro").addEventListener("click", () => { idx = 0; show(0); });
  show(0);
}

function showIntro() {
  $("#intro").hidden = false;
}

function dismissIntro() {
  $("#intro").hidden = true;
  const wasFirstTime = !activity.intro_seen;
  activity.intro_seen = true;
  commit();
  if (wasFirstTime) startSession();
}

/* ---------- Session ---------- */

function startSession() {
  sessionStartedAt = Date.now();
  sessionStreak = 0;
  updateStreakDisplay();
  const today = todayKey();
  const todayCounts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0 };
  session = buildSession(deck.cards, stateMap, settings, todayCounts);
  activity.due_reviews_offered += session.reviews.length;
  showNextCard();
}

function showNextCard() {
  const reviews = session.reviews;
  const fresh = session.new;
  if (reviews.length === 0 && fresh.length === 0) {
    renderDone();
    return;
  }
  const pickReview = reviews.length > 0 && (fresh.length === 0 || Math.random() < 0.8);
  currentCard = pickReview ? reviews.shift() : fresh.shift();
  currentIsNew = !pickReview;
  renderCard(currentCard);
  cardShownAt = Date.now();
}

function renderCard(card) {
  const fb = $("#feedback");
  fb.textContent = ""; fb.className = "feedback";
  $("#next-btn").hidden = true;
  $("#next-btn").disabled = true;
  $("#submit-btn").hidden = false;
  $("#card").classList.remove("flash-ok", "flash-bad");

  const body = $("#card-body");
  body.innerHTML = "";

  if (card.mode === "typed") {
    body.innerHTML = `
      <p class="prompt">${escapeHtml(card.prompt)}</p>
      <input id="answer-input" type="text" autocomplete="off" autofocus />
    `;
  } else if (card.mode === "cloze") {
    const parts = card.text.split(/(\{\{[^}]+\}\})/g);
    const html = parts.map(p => {
      const m = p.match(/^\{\{([^}]+)\}\}$/);
      if (!m) return escapeHtml(p);
      return `<input class="cloze-input" data-key="${m[1]}" type="text" autocomplete="off" />`;
    }).join("");
    body.innerHTML = `<p class="prompt">${html}</p>`;
  } else if (card.mode === "mc") {
    const options = [card.correct, ...card.distractors];
    if (card.shuffle !== false) shuffle(options);
    body.innerHTML = `
      <p class="prompt">${escapeHtml(card.prompt)}</p>
      <div class="choices">
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
  const { quality, correct, productive } = result;

  updateSM2(stateMap[currentCard.id], quality, settings.sm2);

  const today = todayKey();
  const counts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0 };
  if (currentIsNew) counts.new += 1; else counts.reviews += 1;
  activity.daily_counts[today] = counts;
  if (productive && correct) activity.productive_reviews += 1;
  if (!currentIsNew && correct) activity.on_schedule_reviews += 1;

  renderFeedback(currentCard, response, result);
  flashCard(correct);
  updateStreak(correct);
  lockoutNext();
  recordSessionMinutes();
  refreshStats();
  commit();
}

function renderFeedback(card, response, { correct, quality }) {
  const fb = $("#feedback");
  if (correct) {
    fb.className = "feedback ok";
    fb.innerHTML = `✓ Correct${quality === 5 ? " — quick recall!" : ""}`;
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
    const rows = Object.entries(card.acceptable).map(([k, v]) => `
        <span class="label">${escapeHtml(k)}:</span>
        <span class="yours">${escapeHtml(response?.[k] || "(blank)")}</span>
        <span class="label"></span>
        <span class="truth">${escapeHtml(v[0])}</span>`).join("");
    html += `<div class="answer-compare">${rows}</div>`;
  } else if (card.mode === "mc") {
    const labels = document.querySelectorAll(".choices label");
    labels.forEach(lab => {
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
  } else {
    sessionStreak = 0;
  }
  updateStreakDisplay();
}

function updateStreakDisplay() {
  $("#streak-count").textContent = sessionStreak;
}

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

function renderDone() {
  $("#card-body").innerHTML = `
    <p class="prompt">🎉 No more cards due today.</p>
    <p style="color: var(--muted);">Come back tomorrow — your engagement score rewards studying across days, not cramming in one.</p>
  `;
  $("#submit-btn").hidden = true;
  $("#next-btn").hidden = true;
}

function refreshStats() {
  const score = computeScore(deck.cards, stateMap, activity, settings);
  $("#stat-mastery").textContent = `${score.mastered_count}/${score.total_cards}`;
  $("#stat-engagement").textContent = (score.engagement * 100).toFixed(0) + "%";
  $("#stat-completion").textContent = (score.completion * 100).toFixed(0) + "%";
  $("#stat-final").textContent = (score.final * 100).toFixed(1);
  $("#mastery-fill").style.width = (score.mastery * 100).toFixed(1) + "%";

  const today = todayKey();
  const counts = activity.daily_counts[today] || { new: 0, reviews: 0, minutes: 0 };
  $("#stat-new").textContent = `${counts.new} / ${settings.schedule.daily_new_card_limit}`;
  $("#stat-reviews").textContent = `${counts.reviews} / ${settings.schedule.daily_review_limit}`;

  SCORM.setScore(score.final);
  SCORM.setProgress(score.completion);
  SCORM.setSuccess(score.final >= settings.scoring.pass_threshold ? "passed" : "unknown");
  SCORM.setCompletion(score.completion >= 0.95 ? "completed" : "incomplete");
}

function commit() {
  SCORM.setSuspendData({ stateMap, activity });
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
