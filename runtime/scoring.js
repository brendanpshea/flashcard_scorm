// Score = mastery * (floor + (1-floor) * engagement) * completion_factor
import { isMastered } from "./sm2.js";

// Target active days: explicit setting wins; otherwise derived from deck size
// and the daily new-card limit. The formula = days-to-introduce + review-tail,
// where the review tail is roughly the time for the last-introduced card to
// reach mastery interval (~7 days at default SM-2 ease).
export function resolveTargetActiveDays(totalCards, settings) {
  const explicit = settings.schedule.target_active_days;
  if (explicit) return explicit;
  const newLimit = settings.schedule.daily_new_card_limit;
  const introDays = Math.ceil(totalCards / newLimit);
  const reviewTail = 7;
  return introDays + reviewTail;
}

export function computeScore(cards, stateMap, activityLog, settings) {
  const req = settings.scoring.mastery_requires;
  const total = cards.length;
  let mastered = 0, attemptedSeriously = 0, started = 0;
  let masteryProgressSum = 0;
  for (const card of cards) {
    const st = stateMap[card.id];
    if (!st) continue;
    if (st.attempts >= 1) started += 1;
    if (st.attempts >= 2 && st.correct_count >= 1) attemptedSeriously += 1;
    if (isMastered(st, req)) mastered += 1;

    // Continuous per-card progress toward mastery: average of "how many
    // corrects accumulated" and "is the card currently confirmed (not
    // lapsed)". Gives day-1 students visible movement, drops sharply on a
    // lapse so the bar reflects the real recovery work.
    const correctProgress = Math.min(1, st.correct_count / req.correct_count);
    const confirmProgress = st.repetitions >= 1 ? 1 : 0;
    masteryProgressSum += (correctProgress + confirmProgress) / 2;
  }
  const mastery = total ? mastered / total : 0;
  const masteryProgress = total ? masteryProgressSum / total : 0;
  const completion = total ? attemptedSeriously / total : 0;
  const startedFraction = total ? started / total : 0;
  const engagement = computeEngagement(activityLog, cards.length, settings);

  const floor = settings.scoring.engagement_floor;
  const engMultiplier = floor + (1 - floor) * engagement;

  // Grade sent to D2L — unchanged.
  const final = mastery * engMultiplier * completion;
  return {
    final,
    mastery,
    masteryProgress,        // continuous; used for the visible bar only
    engagement,
    completion,
    startedFraction,        // for the two-tier bar
    mastered_count: mastered,
    total_cards: total
  };
}

function computeEngagement(log, totalCards, settings) {
  const w = settings.engagement.weights;
  const targetActiveDays = resolveTargetActiveDays(totalCards, settings);
  const targetReviews = totalCards * settings.engagement.desired_passes_per_card;

  const activeDays = (log.active_days || []).length;
  const productive = log.productive_reviews || 0;
  const onSched = log.on_schedule_reviews || 0;
  const due = Math.max(1, log.due_reviews_offered || 1);

  const consistency = Math.min(1, activeDays / Math.max(1, targetActiveDays));
  const volume = Math.min(1, productive / Math.max(1, targetReviews));
  const onScheduleRatio = Math.min(1, onSched / due);

  return w.consistency * consistency
       + w.volume * volume
       + w.on_schedule * onScheduleRatio;
}
