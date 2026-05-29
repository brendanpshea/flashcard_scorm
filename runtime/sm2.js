// SM-2 scheduling. Quality scores are derived objectively by the grader,
// not self-reported (see grader.js).
// Dates are integer day numbers (UTC days since epoch) to keep suspend_data small.

export const MS_PER_DAY = 86400000;

// Day numbers key the whole schedule (due dates, active days, daily counts).
// By default we use the *local* calendar day: UTC days roll over at midnight
// UTC, so a student studying at 11pm in a western timezone would otherwise see
// the session land on "tomorrow," splitting an active day and skewing streaks.
// Set day_boundary: "utc" in class settings to force UTC (e.g. for tests or a
// globally distributed cohort where a fixed boundary is preferable).
let useLocalDay = true;
export function configureDayBoundary(mode) {
  useLocalDay = mode !== "utc";
}
export const today = () => {
  const offsetMs = useLocalDay ? new Date().getTimezoneOffset() * 60000 : 0;
  return Math.floor((Date.now() - offsetMs) / MS_PER_DAY);
};

export function newCardState(_cardId, startingEase = 2.5) {
  return {
    ease: startingEase,
    interval_days: 0,
    repetitions: 0,
    due: today(),
    lapses: 0,
    correct_count: 0,
    attempts: 0
  };
}

export function updateSM2(state, quality, sm2Config) {
  const minEase = sm2Config.min_ease ?? 1.3;
  const lapseInterval = sm2Config.lapse_interval_days ?? 1;
  state.attempts += 1;

  if (quality < 3) {
    state.repetitions = 0;
    state.interval_days = lapseInterval;
    state.lapses += 1;
  } else {
    state.correct_count += 1;
    state.repetitions += 1;
    if (state.repetitions === 1) state.interval_days = 1;
    else if (state.repetitions === 2) state.interval_days = 6;
    else state.interval_days = Math.round(state.interval_days * state.ease);

    state.ease = Math.max(
      minEase,
      state.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );
  }

  state.due = today() + state.interval_days;
  return state;
}

export function isDue(state, now = today()) {
  return state.due <= now;
}

// Mastery leans on the natural spacing SM-2 already enforces (correct_count >= 3
// implies the card has been due, and answered correctly, on at least 3 separate
// days). `repetitions >= 1` excludes currently-lapsed cards — a card that just
// dropped back to a 1-day interval isn't mastered, even with many lifetime
// corrects. `min_interval_days` (optional) adds an explicit interval gate: the
// card's current interval must have grown to at least M days, so a class can
// require the spacing to have demonstrably elapsed rather than inferring it.
export function isMastered(state, requires) {
  if (state.correct_count < requires.correct_count) return false;
  if (state.repetitions < 1) return false;
  if (requires.min_interval_days != null
      && state.interval_days < requires.min_interval_days) return false;
  return true;
}

export function buildStudyAhead(allCards, stateMap) {
  const now = today();
  return allCards
    .filter(c => {
      const st = stateMap[c.id];
      return st && st.attempts > 0 && st.due > now;
    })
    .sort((a, b) => stateMap[a.id].due - stateMap[b.id].due);
}

export function buildSession(allCards, stateMap, settings, todayCounts) {
  const newLimit = settings.schedule.daily_new_card_limit;
  const reviewLimit = settings.schedule.daily_review_limit;
  const newRemaining = Math.max(0, newLimit - (todayCounts.new || 0));
  const reviewRemaining = Math.max(0, reviewLimit - (todayCounts.reviews || 0));

  const now = today();
  const reviews = [];
  const fresh = [];
  for (const card of allCards) {
    const st = stateMap[card.id];
    if (!st || st.attempts === 0) fresh.push(card);
    else if (isDue(st, now)) reviews.push(card);
  }
  reviews.sort((a, b) => stateMap[a.id].due - stateMap[b.id].due);

  return {
    reviews: reviews.slice(0, reviewRemaining),
    new: fresh.slice(0, newRemaining)
  };
}
