// System-wide defaults. A class_settings.json (if present) is deep-merged
// over this. Most authors never need a settings file at all.

export const DEFAULT_SETTINGS = {
  course: null,                // optional display tag; hidden when null
  schedule: {
    daily_new_card_limit: 20,
    daily_review_limit: 100
    // target_active_days: omitted → derived from deck size
  },
  scoring: {
    pass_threshold: 0.7,
    engagement_floor: 0.6,
    mastery_requires: { correct_count: 3 }
  },
  engagement: {
    weights: { consistency: 0.5, volume: 0.3, on_schedule: 0.2 },
    min_session_minutes_for_active_day: 5,
    min_latency_ms_for_productive_review: 800,
    desired_passes_per_card: 3
  },
  sm2: {
    starting_ease: 2.5,
    min_ease: 1.3,
    lapse_interval_days: 1
  }
};

export function mergeSettings(overrides) {
  return deepMerge(DEFAULT_SETTINGS, overrides || {});
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === "object" && !Array.isArray(v)
              && base[k] && typeof base[k] === "object")
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}
