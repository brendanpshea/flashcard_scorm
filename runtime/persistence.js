// Encode/decode the suspend_data blob. Keeps the wire format compact and
// versioned; in-memory shapes stay readable.
//
// Wire format (v1):
//   { v: 1,
//     s: { [cardId]: { e, i, r, d, l, c, a } },   // only cards with attempts >= 1
//     a: { f, x, ad, p, o, dr, dc } }
//
// Fields:
//   stateMap[card]: e=ease, i=interval_days, r=repetitions, d=due (day#),
//                   l=lapses, c=correct_count, a=attempts
//   activity: f=first_launch_day, x=intro_seen, ad=active_days[],
//             p=productive_reviews, o=on_schedule_reviews,
//             dr=due_reviews_offered, dc=daily_counts

export const SCHEMA_VERSION = 1;

// ~50KB headroom on SCORM 2004 (64KB cap); ~3KB on SCORM 1.2 (4KB cap).
// Caller decides whether to act on the warning.
export const SIZE_WARN_BYTES_2004 = 50_000;

export function encodeState(stateMap, activity) {
  const s = {};
  for (const [id, st] of Object.entries(stateMap)) {
    if (!st || st.attempts === 0) continue;  // lazy-init: skip untouched cards
    s[id] = {
      e: round2(st.ease),
      i: st.interval_days,
      r: st.repetitions,
      d: st.due,
      l: st.lapses,
      c: st.correct_count,
      a: st.attempts
    };
  }
  return {
    v: SCHEMA_VERSION,
    s,
    a: {
      f: activity.first_launch_day,
      x: activity.intro_seen ? 1 : 0,
      ad: activity.active_days || [],
      p: activity.productive_reviews || 0,
      o: activity.on_schedule_reviews || 0,
      dr: activity.due_reviews_offered || 0,
      dc: pruneDailyCounts(activity.daily_counts || {}, activity.first_launch_day)
    }
  };
}

export function decodeState(blob, allCards, startingEase) {
  // Default state for any card not yet attempted; provides the lazy-init half.
  const stateMap = {};
  for (const card of allCards) stateMap[card.id] = defaultState(startingEase);

  const activity = defaultActivity();
  if (!blob || blob.v !== SCHEMA_VERSION) return { stateMap, activity, migrated: !!blob };

  for (const [id, st] of Object.entries(blob.s || {})) {
    if (!stateMap[id]) continue;  // card removed from deck since last save
    stateMap[id] = {
      ease: st.e,
      interval_days: st.i,
      repetitions: st.r,
      due: st.d,
      lapses: st.l,
      correct_count: st.c,
      attempts: st.a
    };
  }
  const a = blob.a || {};
  Object.assign(activity, {
    first_launch_day: a.f ?? activity.first_launch_day,
    intro_seen: !!a.x,
    active_days: a.ad || [],
    productive_reviews: a.p || 0,
    on_schedule_reviews: a.o || 0,
    due_reviews_offered: a.dr || 0,
    daily_counts: a.dc || {}
  });
  return { stateMap, activity, migrated: false };
}

function defaultState(ease) {
  return { ease, interval_days: 0, repetitions: 0, due: today(), lapses: 0, correct_count: 0, attempts: 0 };
}

function defaultActivity() {
  return {
    first_launch_day: today(),
    intro_seen: false,
    active_days: [],
    productive_reviews: 0,
    on_schedule_reviews: 0,
    due_reviews_offered: 0,
    daily_counts: {}
  };
}

// Keep only the last 7 days of detailed counts plus today. Older days'
// "was this an active day" bit lives in active_days already.
function pruneDailyCounts(daily, firstLaunchDay) {
  const cutoff = today() - 7;
  const out = {};
  for (const [k, v] of Object.entries(daily)) {
    if (Number(k) >= cutoff) out[k] = v;
  }
  return out;
}

const today = () => Math.floor(Date.now() / 86400000);
const round2 = (n) => Math.round(n * 100) / 100;

export function byteSize(obj) { return new TextEncoder().encode(JSON.stringify(obj)).length; }
