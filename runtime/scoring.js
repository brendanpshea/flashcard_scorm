// Score = mastery * (floor + (1-floor) * engagement) * completion_factor
import { isMastered } from "./sm2.js";

export function computeScore(cards, stateMap, activityLog, settings) {
  const total = cards.length;
  let mastered = 0, attemptedSeriously = 0;
  for (const card of cards) {
    const st = stateMap[card.id];
    if (!st) continue;
    if (isMastered(st, settings.scoring.mastery_requires)) mastered += 1;
    if (st.attempts >= 2 && st.correct_count >= 1) attemptedSeriously += 1;
  }
  const mastery = total ? mastered / total : 0;
  const completion = total ? attemptedSeriously / total : 0;
  const engagement = computeEngagement(activityLog, cards.length, settings);

  const floor = settings.scoring.engagement_floor;
  const engMultiplier = floor + (1 - floor) * engagement;

  const final = mastery * engMultiplier * completion;
  return {
    final,
    mastery,
    engagement,
    completion,
    mastered_count: mastered,
    total_cards: total
  };
}

function computeEngagement(log, totalCards, settings) {
  const w = settings.engagement.weights;
  const sched = settings.schedule;
  const targetActiveDays = sched.duration_weeks * sched.target_active_days_per_week;
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
