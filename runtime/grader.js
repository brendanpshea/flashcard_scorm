// Objective grader. Returns quality 0..5 for SM-2.

export function gradeAnswer(card, response, latencyMs, settings) {
  const minLatency = settings.engagement.min_latency_ms_for_productive_review;
  const productive = latencyMs >= minLatency;

  let correct = false, close = false;
  let perBlank = null;   // populated for cloze; null otherwise
  if (card.mode === "typed") {
    const tol = card.fuzzy?.max_edit_distance ?? 2;
    const cs = card.fuzzy?.case_sensitive ?? false;
    const r = norm(response, cs);
    const { dist, len } = bestMatch(card.answers, r, cs);
    correct = dist <= tol;
    close = !correct && isClose(dist, tol, len);
  } else if (card.mode === "mc") {
    correct = response === card.correct;
  } else if (card.mode === "cloze") {
    const cs = card.case_sensitive ?? false;
    const tol = card.fuzzy?.max_edit_distance ?? 1;
    perBlank = {};
    let allCorrect = true, anyClose = false;
    for (const k of Object.keys(card.acceptable)) {
      const r = norm(response?.[k] ?? "", cs);
      const { dist, len } = bestMatch(card.acceptable[k], r, cs);
      const ok = dist <= tol;
      const closeOnly = !ok && isClose(dist, tol, len);
      perBlank[k] = { correct: ok, close: closeOnly };
      if (!ok) allCorrect = false;
      if (closeOnly) anyClose = true;
    }
    correct = allCorrect;
    close = !correct && anyClose;
  }

  let quality;
  if (correct && productive) quality = 5;
  else if (correct && !productive) quality = 4;
  else if (close) quality = 2;
  else quality = 1;

  return { quality, correct, productive, perBlank };
}

// Edit distance to the nearest acceptable answer, plus that answer's length
// (used to scale the "close" band to the size of the word).
function bestMatch(answers, r, cs) {
  let dist = Infinity, len = 0;
  for (const a of answers) {
    const na = norm(a, cs);
    const d = editDistance(na, r);
    if (d < dist) { dist = d; len = na.length; }
  }
  return { dist, len };
}

// "Close" = a genuine near-miss worth a "so close" nudge: just past the
// tolerance (one extra edit) AND small relative to the answer. Without the
// length term, every wrong short answer ("dog" vs "cat") would read as close.
const CLOSE_LEN_RATIO = 0.34;  // within roughly a third of the word
function isClose(dist, tol, targetLen) {
  return dist > tol
      && dist <= tol + 1
      && dist <= Math.ceil(targetLen * CLOSE_LEN_RATIO);
}

function norm(s, caseSensitive) {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return caseSensitive ? t : t.toLowerCase();
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}
