// Objective grader. Returns quality 0..5 for SM-2.

export function gradeAnswer(card, response, latencyMs, settings) {
  const minLatency = settings.engagement.min_latency_ms_for_productive_review;
  const productive = latencyMs >= minLatency;

  let correct = false, close = false;
  if (card.mode === "typed") {
    const tol = card.fuzzy?.max_edit_distance ?? 2;
    const cs = card.fuzzy?.case_sensitive ?? false;
    const r = norm(response, cs);
    correct = card.answers.some(a => editDistance(norm(a, cs), r) <= tol);
    close = !correct && card.answers.some(a => editDistance(norm(a, cs), r) <= tol + 2);
  } else if (card.mode === "mc") {
    correct = response === card.correct;
  } else if (card.mode === "cloze") {
    const cs = card.case_sensitive ?? false;
    const tol = card.fuzzy?.max_edit_distance ?? 1;
    const perBlank = {};
    let allCorrect = true, anyClose = false;
    for (const k of Object.keys(card.acceptable)) {
      const r = norm(response?.[k] ?? "", cs);
      const ok = card.acceptable[k].some(a => editDistance(norm(a, cs), r) <= tol);
      const closeOnly = !ok && card.acceptable[k].some(a => editDistance(norm(a, cs), r) <= tol + 2);
      perBlank[k] = { correct: ok, close: closeOnly };
      if (!ok) allCorrect = false;
      if (closeOnly) anyClose = true;
    }
    correct = allCorrect;
    close = !correct && anyClose;
    var cloze_per_blank = perBlank;
  }

  let quality;
  if (correct && productive) quality = 5;
  else if (correct && !productive) quality = 4;
  else if (close) quality = 2;
  else quality = 1;

  return { quality, correct, productive, perBlank: typeof cloze_per_blank !== "undefined" ? cloze_per_blank : null };
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
