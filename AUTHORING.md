# Deck Authoring Guide (for LLMs)

This guide is written for an LLM tasked with authoring flashcard decks for the flashcard_scorm system. Follow it precisely. The system runs as a SCORM 2004 package inside an LMS; cards are graded objectively, so prompts and answers must be unambiguous and machine-checkable.

## Output format

You write **markdown**. The build pipeline (`tools/md2json.js`) converts your markdown to JSON. There is no other supported authoring path.

### File structure

- One file is fine for small decks (< ~30 cards).
- For larger decks, split by topic into multiple files in a directory. Files are read in sorted filename order. Prefix filenames to control sequence: `00-deck.md`, `10-topic-a.md`, `20-topic-b.md`. The numeric prefix is convention, not magic — it just controls sort order.
- One file (conventionally `00-deck.md`) declares the deck header. Other files contain card sections only.

### Deck header

Exactly one header section is required across the deck. Place it at the top of one file (no `---` before it).

```markdown
# Deck: <Human-readable deck title>
id: <kebab-case-id>
version: 1
```

- `id` must be unique across decks the instructor uploads. Use kebab-case.
- `title` is what students see.
- `version` is for your own bookkeeping; bump when you change cards.

### Card sections

Each card is a section separated by a line containing only `---`. The first `---` in a file separates the header from the first card.

```markdown
---
mode: typed
tags: tag-a, tag-b
hint: Optional one-line hint shown on wrong answers.
Q: The prompt text.
A: accepted answer 1
A: accepted answer 2
```

- `mode:` is required and must be one of `typed`, `cloze`, `mc`.
- `tags:` is optional, comma-separated. Use for topic grouping; the runtime currently uses tags only for analytics and future filtering.
- `hint:` is optional. Appears as a small callout on wrong answers. Keep under ~80 characters.
- `id:` is optional. If omitted, IDs are auto-assigned (`c001`, `c002`, ...). If you write IDs, they must be unique across all files. Auto-assignment is usually fine; only write IDs if you have a specific reason.
- `Q:` is the prompt. Required for all modes. For cloze, the prompt itself contains `{{key}}` placeholders.

Mode-specific fields are described below.

## Card mode selection

**The single most important authoring decision is choosing the right mode.** A bad mode choice creates cards that grade poorly, frustrate students, or invite gaming.

Use this decision flow:

1. **Is the answer a short, well-defined term, name, number, or canonical phrase?** → `typed`
2. **Is the prompt a sentence with one or more specific words missing?** → `cloze`
3. **Does the answer require discrimination between similar-looking options, or articulation of an idea that can be paraphrased many ways?** → `mc`

Roughly, target this distribution: **60% typed, 30% cloze, 10% mc.** Cloze and typed produce stronger learning (active production beats recognition). MC is a fallback when objective grading of free-form text would be unreliable.

## Mode 1: typed

The student types a free-form short answer. The grader uses fuzzy matching (default: edit distance ≤ 2, case-insensitive) against the list of accepted `A:` lines.

### Use typed when

- The answer is a single term, name, acronym, port number, year, or short canonical phrase.
- There are at most a small number of acceptable phrasings.
- Misspellings of the right answer should be forgiven; conceptually different answers should not.

### Format

```markdown
---
mode: typed
tags: protocols
Q: Which TCP/IP layer is responsible for end-to-end communication?
A: transport
A: transport layer
A: the transport layer
```

### Rules

- List **all reasonable phrasings** as `A:` lines. If a student could legitimately write "the transport layer" or just "transport", include both. Aim for 1–4 acceptable answers.
- Do **not** include misspellings as `A:` lines — fuzzy matching handles those.
- Do **not** include synonyms that are merely *related* — if "transport" and "session" are both valid in some loose reading, the prompt is too vague. Rewrite the prompt.
- Prefer prompts where the answer is a noun or short noun phrase. Verbs and adjectives are fine but produce wider answer-space ambiguity.

### Good typed cards

```markdown
---
mode: typed
tags: ports
Q: What is the well-known port for HTTPS?
A: 443

---
mode: typed
tags: fallacies
Q: Name the fallacy of attacking the person rather than their argument.
A: ad hominem
A: ad hominem fallacy

---
mode: typed
tags: latin-terms
Q: What is the Latin name for the rule "If P then Q; P; therefore Q"?
A: modus ponens
```

### Bad typed cards (do NOT write these)

```markdown
---
mode: typed
Q: What is TCP?
A: a connection-oriented protocol
A: a reliable transport protocol
A: transmission control protocol
```
*Wrong because the prompt invites essay-length answers that won't fuzzy-match to a short canonical form. Rewrite as cloze or split into multiple narrow cards: one for the acronym, one for the protocol family, one for the reliability property.*

```markdown
---
mode: typed
Q: Why is encryption important?
A: it protects data
```
*Wrong because the answer space is unbounded — there are dozens of valid phrasings, none of which the grader can recognize. This kind of question must be MC, or split into specific factual cards.*

## Mode 2: cloze

The student types into one or more blanks within a sentence. Each `{{key}}` placeholder in the prompt becomes an input field; the student must fill all of them correctly.

### Use cloze when

- The card teaches a sentence-level fact and a specific word or phrase carries the meaning.
- The blanked word is short (1–3 words) and has a small number of acceptable phrasings.
- The surrounding sentence provides context that disambiguates the answer.

### Format

```markdown
---
mode: cloze
tags: protocols
Q: The {{TCP}} protocol provides reliable, ordered delivery, while {{UDP}} is connectionless and best-effort.
TCP: TCP
UDP: UDP
```

Each `{{key}}` in the `Q:` must have a corresponding `key: value` line below specifying the accepted answer for that blank. Multiple blanks are fine but keep it to ≤3 per card. The build will fail if a placeholder has no matching answer.

### Rules

- **Blank the word that carries the meaning**, not a filler word. "{{Modus ponens}} is a rule of inference" tests the term; "Modus ponens is a {{rule}} of inference" tests trivia.
- **Don't blank words that can be inferred from grammar.** "Modus ponens is {{a}} rule of inference" is useless.
- **The unblanked part of the sentence should disambiguate the blank.** If the surrounding context allows multiple plausible answers, the card grades poorly.
- **Capitalization is matched case-insensitively by default.** Don't worry about it.
- Per-key cloze answers currently accept a single phrasing (no synonym lists per blank). If the blank could legitimately be filled multiple ways, either pick the canonical form and rephrase the sentence, or use typed mode.

### Good cloze cards

```markdown
---
mode: cloze
tags: osi-layers
Q: The OSI {{transport}} layer (layer {{4}}) handles end-to-end communication.
transport: transport
4: 4

---
mode: cloze
tags: validity
Q: An argument is {{sound}} when it is both valid and has true premises.
sound: sound

---
mode: cloze
tags: cabling
Q: Cat {{6}} cable supports speeds up to {{10}} Gbps over short distances.
6: 6
10: 10
```

### Bad cloze cards

```markdown
---
mode: cloze
Q: TCP is a {{protocol}}.
protocol: protocol
```
*Wrong because the blank could be "protocol", "standard", "spec", "thing", etc. The sentence doesn't disambiguate. Either rephrase to test something specific or switch modes.*

```markdown
---
mode: cloze
Q: {{Encryption}} is important because it {{protects}} {{data}}.
Encryption: encryption
protects: protects
data: data
```
*Wrong because three blanks across a vague sentence test nothing in particular. Cloze works best for one or two precisely-chosen blanks in a context-rich sentence.*

## Mode 3: multiple choice (mc)

The student picks one option from a list. Exact match against the `*:` correct option; other options are `-:` distractors.

### Use MC when

- The card teaches **discrimination** — telling similar concepts apart.
- The answer is conceptual and could be phrased many ways, but plausible wrong answers exist.
- A typed or cloze answer would have too wide a fuzzy-match space.

### Format

```markdown
---
mode: mc
tags: fallacies
Q: Which fallacy attacks the person rather than their argument?
*: ad hominem
-: straw man
-: red herring
-: appeal to authority
```

- Exactly one `*:` (correct).
- 2–4 `-:` distractors. The system shuffles options at render time by default.

### Rules for writing good distractors

This is where MC cards live or die. Bad distractors make the answer obvious; good distractors actually test understanding.

- **Distractors must be plausible.** A student who doesn't know the answer should genuinely consider each option. "Which is a transport protocol? TCP / UDP / banana / sky" tests nothing.
- **Distractors must be the same category as the answer.** All four should be fallacies, or all four should be protocols, or all four should be philosophers. Mixing categories signals the answer.
- **Distractors must be parallel in form and length.** If the correct answer is "modus ponens" (two words), distractors should also be short technical terms. A long verbose distractor among short ones is a tell.
- **Distractors must be unambiguously wrong.** No "kind of true depending on interpretation" options. The student should be able to defend any distractor as definitely incorrect once they know the material.
- **Pull distractors from the same conceptual neighborhood.** For fallacies, use other fallacies the student is expected to know. For protocols, use other protocols at the same OSI layer. This forces real discrimination, not just recognition.

### Good MC card

```markdown
---
mode: mc
tags: rules-of-inference
Q: Which of these is a deductively invalid argument form?
*: affirming the consequent
-: modus tollens
-: modus ponens
-: hypothetical syllogism
```

### Bad MC cards

```markdown
---
mode: mc
Q: What is TCP?
*: a connection-oriented protocol
-: a sandwich
-: a programming language
-: a planet
```
*Wrong: distractors are silly, making the answer obvious. The card tests nothing.*

```markdown
---
mode: mc
Q: What is the best protocol?
*: TCP
-: UDP
-: HTTP
-: FTP
```
*Wrong: "best" is subjective; multiple options are defensible; the prompt isn't a real question. Rewrite as a specific factual prompt.*

## Anti-patterns across all modes

These mistakes show up regardless of mode. Avoid them all:

- **Two-concept cards.** "What is TCP and why is it reliable?" Tests two things and graders only check one. Split into two cards.
- **Negation in prompts.** "Which is *not* a transport protocol?" Students misread negations under time pressure, and the card tests reading comprehension more than knowledge. Rewrite positively when possible.
- **Trick wording.** "Which of these is technically also considered..." If the card relies on a gotcha rather than the material, it's a bad card.
- **Vague prompts that depend on context the student doesn't have.** "What does it do?" — what does what do? Make every prompt self-contained.
- **Prompts that give away the answer.** "What three-letter acronym is used for the Transmission Control Protocol?" The answer is in the prompt.
- **Answer keys that depend on case, punctuation, or whitespace.** The grader normalizes whitespace and is case-insensitive by default. Don't write `A: TCP.` (with period) and expect the grader to demand the period — it won't, and if a student writes `tcp`, it still passes.
- **Cards that test the test, not the material.** "What is the third card in this deck?" or "What did the previous card say?" — never write meta-cards.

## Hints

Use the optional `hint:` field for cards where a confused student could productively be nudged.

Good hint: `hint: Think about which layer terminates the conversation, not which routes the packets.`
Bad hint: `hint: It's transport.` (gives the answer)
Bad hint: `hint: Try again.` (says nothing)

Hints are shown only on wrong answers. They are not used by the grader; they're purely UX.

## Quantity and scope

- A single deck should cover **one topical unit** (a chapter, a module, a week's content). Not a whole course.
- Target **40–80 cards per unit deck**. Below 20 the spaced-repetition benefits get noisy; above 100 the cognitive load per session creeps up.
- A student should be able to clear a full review session in **15–25 minutes** at steady state. That's roughly 30–50 reviews. Scale deck size with that in mind.
- If a unit's content doesn't fit in one deck, split into two themed decks rather than overloading one. The instructor uploads them as separate SCORM packages.

## Build, validate, test workflow

After authoring, run these commands from the project root. Fix any errors before considering the deck done.

### 1. Convert markdown to JSON

```bash
# Single file
node tools/md2json.js decks/<deck-name>/cards.md --out decks/<deck-name>/cards.json

# Multi-file (directory)
node tools/md2json.js decks/<deck-name>/ --out decks/<deck-name>/cards.json
```

Errors here usually mean a syntax mistake in the markdown — a missing field, a cloze placeholder without a matching answer line, a duplicate card ID. The error message names the file and section.

### 2. Validate the JSON

```bash
node tools/validate.js decks/<deck-name>/cards.json
```

The validator catches:
- Missing or duplicate card IDs
- Invalid modes
- Typed cards with no answers
- MC cards with fewer than 2 distractors
- MC distractors that duplicate the correct answer
- Cloze `{{placeholders}}` with no matching acceptable entry, or acceptable keys not referenced by any placeholder
- Missing required deck-level fields

Fix every issue it reports.

### 3. Build a preview and study it

```bash
node build.js --deck decks/<deck-name>/cards.json \
              --settings decks/<deck-name>/settings.json \
              --preview preview/<deck-name>
node serve.js preview/<deck-name> 8080
# open http://localhost:8080
```

Actually click through the cards. Things you can only catch by trying the deck:
- Typed cards where the fuzzy match is too tight or too loose
- MC cards where one option visually pops out (e.g., the correct one is the only capitalized one)
- Cloze cards where the surrounding context makes the answer obvious
- Prompts that are awkward to read on screen

Use the Reset progress button in the stats sidebar between test runs.

### 4. Build the SCORM zip for upload

Once you're satisfied with the preview:

```bash
node build.js --deck decks/<deck-name>/cards.json \
              --settings decks/<deck-name>/settings.json \
              --out dist/<deck-name>.zip
```

The zip is what gets uploaded to D2L.

## Quality checklist before shipping a deck

Before considering a deck done, confirm:

- [ ] `node tools/validate.js` passes with no errors.
- [ ] You've studied through the deck at least once via the preview.
- [ ] Every typed card has all reasonable phrasings listed as `A:` lines.
- [ ] Every MC card has plausible, category-consistent, parallel-form distractors.
- [ ] No card tests two concepts.
- [ ] No prompt contains negation unless absolutely necessary.
- [ ] No prompt or distractor relies on a gotcha or trick reading.
- [ ] Mode distribution is roughly 60% typed, 30% cloze, 10% mc — adjust if the content genuinely calls for a different mix, but justify why.
- [ ] Total card count is appropriate for the unit (40–80 typical).
- [ ] Tags are applied consistently if you used them.
- [ ] The deck header (`id`, `title`, `version`) is set correctly.

## A worked example

A small unit on the OSI model, demonstrating the patterns above:

```markdown
# Deck: OSI Model — Layers and Functions
id: netplus-osi
version: 1

---
mode: typed
tags: osi-layers
Q: What is the bottom layer of the OSI model?
A: physical
A: physical layer
A: layer 1

---
mode: typed
tags: osi-layers
Q: At which numbered layer of the OSI model does TCP operate?
A: 4
A: layer 4

---
mode: cloze
tags: osi-layers
Q: The {{network}} layer (layer {{3}}) is responsible for routing packets between networks.
network: network
3: 3

---
mode: cloze
tags: osi-functions
Q: The {{data link}} layer handles {{MAC}} addressing on the local segment.
data link: data link
MAC: MAC

---
mode: mc
tags: osi-layers
Q: At which OSI layer would you expect to find HTTP?
*: application
-: presentation
-: session
-: transport

---
mode: mc
tags: osi-functions
Q: Which OSI layer would be responsible for character encoding translation?
*: presentation
-: application
-: session
-: transport
hint: Think about who translates between systems with different formats.
```

Notes on this example:
- Mix is 2 typed / 2 cloze / 2 mc — fine for a 6-card teaching example; a real deck would have more typed.
- All MC distractors are other OSI layers (same category, parallel form).
- The cloze card on MAC addressing uses two narrow blanks where the surrounding context disambiguates each.
- The hint on the last card nudges without revealing.

When in doubt, write the card both ways (e.g., once as typed, once as MC) and ask: which version would a student who genuinely understood the material answer correctly without effort, and which would a student who only memorized surface patterns get wrong? Use whichever version creates the larger gap.
