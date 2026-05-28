// SM-2 scheduling. Quality scores are derived objectively by the grader,
// not self-reported (see app.js gradeAnswer).

const DAY_MS = 24 * 60 * 60 * 1000;

export function newCardState(cardId, startingEase = 2.5) {
  return {
    card_id: cardId,
    ease: startingEase,
    interval_days: 0,
    repetitions: 0,
    due: new Date().toISOString(),
    lapses: 0,
    correct_streak: 0,
    correct_count: 0,
    attempts: 0,
    last_seen: null
  };
}

export function updateSM2(state, quality, sm2Config) {
  const minEase = sm2Config.min_ease ?? 1.3;
  const lapseInterval = sm2Config.lapse_interval_days ?? 1;
  const now = new Date();

  state.attempts += 1;
  state.last_seen = now.toISOString();

  if (quality < 3) {
    state.repetitions = 0;
    state.interval_days = lapseInterval;
    state.lapses += 1;
    state.correct_streak = 0;
  } else {
    state.correct_count += 1;
    state.correct_streak += 1;
    state.repetitions += 1;
    if (state.repetitions === 1) state.interval_days = 1;
    else if (state.repetitions === 2) state.interval_days = 6;
    else state.interval_days = Math.round(state.interval_days * state.ease);

    state.ease = Math.max(
      minEase,
      state.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );
  }

  state.due = new Date(now.getTime() + state.interval_days * DAY_MS).toISOString();
  return state;
}

export function isDue(state, now = new Date()) {
  return new Date(state.due).getTime() <= now.getTime();
}

export function isMastered(state, requires) {
  return state.correct_count >= requires.correct_count
      && state.interval_days >= requires.min_interval_days;
}

// Build a session: ~80% due reviews + ~20% new cards, respecting daily caps.
export function buildSession(allCards, stateMap, settings, todayCounts) {
  const newLimit = settings.schedule.daily_new_card_limit;
  const reviewLimit = settings.schedule.daily_review_limit;
  const newRemaining = Math.max(0, newLimit - (todayCounts.new || 0));
  const reviewRemaining = Math.max(0, reviewLimit - (todayCounts.reviews || 0));

  const now = new Date();
  const reviews = [];
  const fresh = [];
  for (const card of allCards) {
    const st = stateMap[card.id];
    if (!st || st.attempts === 0) fresh.push(card);
    else if (isDue(st, now)) reviews.push(card);
  }
  reviews.sort((a, b) =>
    new Date(stateMap[a.id].due) - new Date(stateMap[b.id].due));

  return {
    reviews: reviews.slice(0, reviewRemaining),
    new: fresh.slice(0, newRemaining)
  };
}
