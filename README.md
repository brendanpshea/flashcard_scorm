# flashcard_scorm

A framework for generating adaptive flashcard activities packaged as SCORM 2004 objects for D2L (or any SCORM-compliant LMS). Built around spaced repetition (SM-2), with a grading model that resists gaming by tying the final score to mastery, engagement, and completion together.

## What it does

- Authors write decks in plain markdown; a build script converts them to a SCORM 2004 zip.
- Students study via typed, multiple-choice, or cloze cards. SM-2 schedules reviews per student per card.
- Score is computed continuously and sent to the LMS as `cmi.score.scaled`. Progress survives session interruptions via `cmi.suspend_data`.
- The same deck content can be packaged with different class-settings files (e.g., 5-week summer vs. 16-week semester) without touching the deck.
- Runs standalone via `file://` or a local server — no LMS needed for development.

## Project layout

```
flashcard_scorm/
  runtime/                  # The SCORM SCO: HTML/JS/CSS the student runs
    index.html
    app.js                  # UI, session loop, persistence boundary
    sm2.js                  # SM-2 scheduler (pure)
    grader.js               # Objective grading per card mode (pure)
    scoring.js              # Final score formula (pure)
    persistence.js          # Encode/decode suspend_data (versioned, compact)
    scorm-wrapper.js        # SCORM 2004 API wrapper, localStorage fallback
    styles.css
    package.json            # Node-only: tells Node these .js files are ESM
  decks/
    sample-logic/           # Single-file deck (markdown + settings + cards.json)
    sample-multi/           # Multi-file deck split by topic
  manifest-template/
    imsmanifest.xml         # Templated SCORM 2004 manifest
  tools/
    md2json.js              # Markdown → cards.json (supports glob/dir)
    validate.js              # Deck JSON validator
  tests/
    test.mjs                 # Deterministic tests for pure modules
  build.js                   # SCORM zip builder (no dependencies)
  serve.js                   # Local static server for preview
  package.json
```

## Quick start

```bash
# Run the test suite
npm test

# Validate a deck
npm run validate

# Build the preview folder and serve locally
npm run preview:5week
npm run serve
# open http://localhost:8080

# Build a SCORM zip for D2L upload
npm run build:5week        # → dist/sample-logic-5week.zip
npm run build:16week       # → dist/sample-logic-16week.zip

# Multi-file deck pipeline (markdown → JSON → SCORM)
npm run build:multi
```

## Authoring decks

Cards live in markdown. Each card is one `---`-separated section. The first section of one file declares the deck-level header.

```markdown
# Deck: Intro Logic — Core Terms
id: phil101-logic
version: 1

---
mode: typed
tags: validity
hint: Think about logical form, not truth.
Q: What do we call an argument whose premises guarantee its conclusion?
A: valid
A: a valid argument

---
mode: cloze
tags: soundness
Q: An argument is {{sound}} when it is valid and all its premises are true.
sound: sound

---
mode: mc
tags: fallacies
Q: Which fallacy attacks the person rather than their argument?
*: ad hominem
-: straw man
-: red herring
-: appeal to authority
```

For larger decks, split into multiple files in a directory. Files are read in sorted filename order; prefix with `00-`, `10-`, `20-` to control sequence. Card IDs must be unique across all files.

```bash
node tools/md2json.js decks/netplus/ --out decks/netplus/cards.json
```

### Card modes

| Mode | Use when | Grading |
|------|----------|---------|
| `typed` | Short factual recall (terms, port numbers, names) | Fuzzy match against `A:` lines (configurable edit distance) |
| `cloze` | Definitions, fill-in-the-blank | All `{{key}}` blanks must match per-key acceptable answers |
| `mc` | Discrimination, application | Exact match against `*:` correct, distractors as `-:` lines |

The grader returns a quality score 0–5 derived from correctness and response latency. Self-rating is **not** used for grading — only objective answer events affect the gradebook number.

## Scoring model

```
final = mastery × (engagement_floor + (1 - engagement_floor) × engagement)
```

- **mastery** = mastered cards / total cards. A card is mastered when `correct_count ≥ N`, it isn't currently lapsed, and — if `min_interval_days` is set for the class — its current review interval has reached that many days.
- **engagement** = weighted combination of consistency (active days / target), productive volume, and on-schedule reviews. Capped at 1.0 — grinding past target gives nothing.
- **engagement_floor** = 0.6 by default. A student with perfect mastery but zero engagement caps at 60% of mastery; with full engagement, 100%. Engagement is required for top marks but never zeros out the grade outright.

**Completion is not a grade factor.** Cards seriously attempted (≥2 attempts, ≥1 correct) / total is still computed and shown to the student, and it drives `cmi.progress_measure` and the "completed" status — but it's deliberately kept out of the grade. Cherry-picking is already capped by mastery, whose denominator is the whole deck: master only the easy 20% and mastery is 0.20, no matter how the rest is left.

The score sent to D2L is recomputed deterministically from the source state on every submit. No cached score field — change the formula and it just works on next launch.

## Display vs. gradebook

The UI shows a prominent "Today" panel (cards practiced, accuracy) as the immediate-feedback hero. The gradebook score is demoted to a smaller "Gradebook score" line and replaced with a short narrative (`"Your gradebook score builds as you master cards across multiple days"`) until the student has actually mastered ≥1 card or hit 20% completion. This prevents the day-1 discouragement of seeing "0.0" after a perfect session, without making the gradebook number itself dishonest.

A two-tier mastery progress bar shows lighter fill for cards started and darker fill for continuous mastery progress (partial credit per card), so day-1 students see visible movement.

## Class settings

Per-offering tunables live in a separate JSON file. Same deck, different settings = different SCORM packages.

```json
{
  "course": "PHIL101-SUMMER",
  "schedule": {
    "duration_weeks": 5,
    "target_active_days_per_week": 4,
    "daily_new_card_limit": 25,
    "daily_review_limit": 150,
    "day_boundary": "local"
  },
  "scoring": {
    "pass_threshold": 0.7,
    "engagement_floor": 0.6,
    "mastery_requires": { "correct_count": 3, "min_interval_days": 5 }
  },
  "engagement": {
    "weights": { "consistency": 0.5, "volume": 0.3, "on_schedule": 0.2 },
    "min_session_minutes_for_active_day": 5,
    "min_cards_for_active_day": 8,
    "min_latency_ms_for_productive_review": 800,
    "desired_passes_per_card": 3
  },
  "sm2": { "starting_ease": 2.5, "min_ease": 1.3, "lapse_interval_days": 1 }
}
```

The deck stays calendar-agnostic; D2L handles per-section availability dates and the engagement formula scales targets by `duration_weeks`.

## SCORM integration

- **Version**: SCORM 2004 4th Edition. Single SCO per package.
- **Suspend data**: versioned wire format with short keys, integer day numbers, and lazy-init (only attempted cards are persisted). A 200-card semester deck encodes in ~10–20KB, well under the 64KB cap. A `commit()`-time size guard logs a warning above ~50KB.
- **Score commit**: `cmi.score.scaled`, `cmi.score.raw`, `cmi.progress_measure` updated on every submit; `LMSCommit` called immediately. `cmi.completion_status` flips to `"completed"` at ≥95% completion; `cmi.success_status` to `"passed"` once the score crosses `pass_threshold`.
- **Resume & time**: on termination the SCO sets `cmi.exit = "suspend"` so the LMS resumes (not restarts) the attempt and hands `suspend_data` back on next launch, and reports time-on-task via `cmi.session_time` (ISO 8601 duration).
- **Standalone mode**: when no LMS API is detected, `scorm-wrapper.js` falls back to a `localStorage`-backed stub. Same code path runs in both environments — no #ifdefs.

### One package per deck/unit

Recommended pattern: one SCORM zip per topical unit, not one for the whole semester. D2L treats each as its own gradebook column and computes the course total natively. Keeps `suspend_data` well-bounded and prevents one corrupted blob from nuking semester-wide progress.

## Accessibility

- Dialog modal uses `role="dialog"`, `aria-modal="true"`, focus trap on Tab, Escape to close, focus restoration on dismiss.
- Feedback region is `role="status"` + `aria-live="polite"`.
- Progress bar exposes `aria-valuenow`. MC choices use `radiogroup`. Typed inputs have explicit labels.
- Visible focus rings on all interactive elements. Animations respect `prefers-reduced-motion`.

## Anti-gaming design

Several decisions stack to make the grade hard to fake:

- **Self-rating tunes scheduling, not grade.** A student who lies about knowing a card sees it more often; the gradebook stays honest.
- **Mastery requires spaced confirmation.** Three correct answers on day 1 doesn't make a card "mastered" — the SM-2 interval has to actually elapse.
- **Whole-deck mastery.** Mastery is mastered/total, so a student who masters only the easy 20% caps at 0.20. No separate completion penalty needed — the denominator does the work.
- **Latency filter.** Sub-`min_latency_ms_for_productive_review` answers don't count toward engagement, even if correct. Stops spam-clicking through cards.
- **Engagement caps.** Once the target is hit, more time/reviews give nothing. Cramming the night before doesn't move the engagement number.

## What's next / not yet done

- D2L upload dry run. The runtime is faithful to SCORM 2004 but real LMS quirks haven't been exercised. This is the next thing to do before authoring real content.
- Stress test with a 500-card deck (e.g., Network+). Storage math says it fits comfortably; worth confirming empirically.
- Instructor-side data export (per-card class-level mastery, struggling-cards report). Not built yet; defer until requested.
- Short-answer mode with keyword coverage. Considered and deferred — most "short-answer" content can be reshaped into typed or MC cards that grade cleanly. Adding it remains an option if specific decks need it.
