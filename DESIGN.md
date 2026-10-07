---
name: ACE Landing
description: Phosphor Terminal, an all-monospace command-line world on curved glass where brightness equals liveness.
colors:
  glass-night: "#0a0f0a"
  glass-deep: "#060906"
  phosphor-live: "#33ff66"
  phosphor-read: "#6ccf95"
  phosphor-dim: "#4aab73"
  armature-line: "#1c4432"
  bloom-white: "#d9ffe6"
typography:
  display:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "clamp(1.05rem, 5.3vw, 6rem)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "clamp(1.25rem, 2.6vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  none: "0px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "32px"
  band: "88px"
components:
  button-primary:
    backgroundColor: "{colors.phosphor-live}"
    textColor: "{colors.glass-night}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.bloom-white}"
    textColor: "{colors.glass-night}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "10px 18px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.phosphor-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "7px 15px"
  button-ghost-hover:
    backgroundColor: "{colors.phosphor-live}"
    textColor: "{colors.glass-night}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "7px 15px"
  button-copy:
    backgroundColor: "transparent"
    textColor: "{colors.phosphor-live}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 11px"
  button-copy-copied:
    backgroundColor: "{colors.phosphor-live}"
    textColor: "{colors.glass-night}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 11px"
---

# Design System: ACE Landing

## Overview

**Creative North Star: "Phosphor Terminal"**

The page is not a website about a CLI tool; it *is* a terminal session. One monospaced voice types and prints down an 80-column field on curved glass, a fixed history rail on the left tracks where you are in the session, and every section is introduced by the command that would produce it (`$ ace init && ace run`, `$ cat package.json`). The aesthetic philosophy is total commitment to the metaphor: there is no marketing layer sitting on top of the terminal, because there is no "top." Brightness is the only hierarchy mechanism. The brightest phosphor (`#33ff66`) means *live or actionable* right now; dimmer phosphor means *reading*; hairline green (`#1c4432`) is the visible armature that rules every table, block, and band. Confirmed rejections: no kickers or eyebrows, no emoji or glyph icons, no gradient text, no hard offset shadows, no second typeface.

Motion is deliberately machine-shaped rather than web-shaped: text arrives by typing or by clip-path reveal, printed lines shed a single phosphor afterimage, the block cursor blinks on a hard step, and scroll only repositions the session. One authored motion language, driven from JavaScript (Motion v14, vendored, durations in seconds), never decorative parallax.

**Key Characteristics:**
- One monospaced voice at every level, from 6rem hero claim to 12.5px footnotes
- Brightness encodes liveness: `#33ff66` live, `#6ccf95` read, `#4aab73` secondary
- Structure drawn with 1px `#1c4432` hairlines, zero corner radius anywhere
- CRT scanline and vignette overlay as world material, fixed above the sheet
- Fixed left history rail (`15ch`) with a `> ` prompt marker on the active section
- Browser surfaces themed to the world: selection, caret, scrollbar, focus ring
- Honest checkout gate styled as part of the session, not a marketing CTA

## Colors

The palette is a single phosphor green family on near-black glass, with brightness steps doing the work that hue variety does elsewhere.

### Primary
- **Phosphor Live** (`#33ff66`): Reserved for anything live or actionable. The hero claim, the shell prompt, links, active rail entries, primary buttons, focus rings, and the block cursor. Roughly 14:1 on the background, the loudest thing on the page by design.
- **Bloom White** (`#d9ffe6`): The hottest point of the live line. Used for the typed command inside the action line, transcript input lines, the code inside CLI rows, and the hover state of primary buttons. It is what "overdriven phosphor" looks like.

### Secondary
- **Phosphor Read** (`#6ccf95`): The reading color. Body copy, lead paragraph, table values, code-block contents. Around 9:1 on background; comfortable for sustained reading at 16px.

### Tertiary
- **Phosphor Dim** (`#4aab73`): Secondary information. Boot line, footnotes, transcript output, inactive rail entries, table keys, footer. Around 6.5:1, above AA for normal text but clearly quieter than Read.

### Neutral
- **Glass Night** (`#0a0f0a`): The page background. A green-tinted near-black, not a neutral gray-black, so the whole glass feels tinted by the phosphor.
- **Glass Deep** (`#060906`): One step deeper. Used for recessed surfaces: the rail, action line, code blocks, scrollbar track. Depth comes from this two-step tonal pairing, never from shadow.
- **Armature Line** (`#1c4432`): Hairline rules only, never text. Borders, row separators, band dividers, focus offsets. The visible grid of the whole page.

### Named Rules
**The Brightness Budget Rule.** Bright phosphor (`#33ff66`) appears only on what is live or actionable in the moment: the claim, the prompt, links, active states, primary buttons. A screen where `#33ff66` covers more than a small fraction of its pixels has broken the world. Its rarity is the point.

**The Never-Text Rule.** `#1c4432` is structure, never type. If a hairline is hard to see, that is correct; if text is that dim, it is wrong.

## Typography

**Display Font:** ui-monospace, with SF Mono / Menlo / Consolas / Liberation Mono fallbacks
**Body Font:** the same monospace stack
**Label/Mono Font:** the same stack (the mono is the only face)

**Character:** A single machine voice speaking at every volume. Hierarchy is achieved with size, weight, and phosphor brightness, never by switching families. The pairing is intentionally absent: the terminal has one font, so the page has one font.

### Hierarchy
- **Display** (700, `clamp(1.05rem, 5.3vw, 6rem)`, line-height 1.12, tracking -0.03em): The hero claim only, in Phosphor Live with a soft bloom. Sized so a 27-character line fits unbroken at every viewport width.
- **Headline** (700, `clamp(1.25rem, 2.6vw, 2rem)`, line-height 1.3, tracking -0.02em): Section commands, always prefixed with `$ ` and set nowrap with horizontal scroll as the escape hatch rather than wrapping.
- **Title** (400, 14px to 16px): Transcript lines, code blocks, action-line command text. Monospace tabular figures keep transcript columns aligned.
- **Body** (400, 16px, line-height 1.65): Reading copy, capped at 72ch measure. Lead paragraph is Body with live-green emphasis spans.
- **Label** (400, 13px, line-height 1.5): Boot line, rail entries, table keys, code-block headers, buttons, footer. 12.5px for the finest legal notes.

### Named Rules
**The One-Voice Rule.** There is exactly one typeface on this page and it is monospace. Never introduce a sans or serif for "readability"; readability comes from measure (72ch), brightness (`#6ccf95`), and line-height (1.65).

**The Command-Heading Rule.** Every section heading is a shell command in Phosphor Live. Headings that are not commands do not belong in this world.

## Layout

A fixed left history rail of `15ch` runs full height on desktop, ruled off by a single hairline. Everything else lives in a sheet offset by the rail, capped at `84ch` and padded `4.5rem` at top with `clamp(1rem, 4vw, 3.5rem)` horizontal padding. Reading copy is narrower still at 72ch; transcripts and code blocks breathe to 80ch; tables rule off at 78ch.

Vertical rhythm is bands: each section opens with `border-top: 1px solid #1c4432` and `padding-top: 5.5rem`, so the hairline itself is the spacing device. The heading sits close to its content (2.4rem below) and far from what precedes it. The hero is a full-viewport (`100svh`) flex column that centers the session vertically.

Row grids: spec tables use `14ch 1fr`; CLI rows use `minmax(24ch, 34ch) 1fr`; both collapse to a single column on narrow screens. Spacing steps are 8px / 16px / 32px with the 88px band step.

Responsive: at **900px** the rail stops being a sidebar and becomes a sticky, horizontally scrollable history bar under a hairline; the sheet loses its left offset; the hero relaxes from full-viewport to `auto` with 3rem padding.

## Elevation & Depth

Flat, by doctrine. The system uses no `box-shadow` for elevation at all: depth is conveyed by tonal layering (Glass Deep recesses into Glass Night), hairline borders that draw every edge, and a fixed CRT vignette that darkens the glass toward its corners so the sheet feels physically curved. Shadows exist only as *light*, never as lift: phosphor bloom on the live claim, glow on the cursor, and the afterimage sweep on freshly printed lines.

### Shadow Vocabulary
- **Claim bloom** (`text-shadow: 0 0 10px rgba(51, 255, 102, 0.35)`): The hero claim only. Overdriven phosphor bleeding into the glass.
- **Cursor glow** (`box-shadow: 0 0 8px rgba(51, 255, 102, 0.6)`): The blinking block cursor, live by definition.
- **Afterimage sweep** (`text-shadow: -10px 0 8px rgba(51, 255, 102, 0.5)` → transparent, 0.6s ease-out): A transcript line's ghost trailing off as it finishes printing.

### Named Rules
**The Bloom Reservation Rule.** Glow is emitted light from live phosphor. It appears on the hero claim, the cursor, and freshly printed transcript lines. It never appears on headings, chrome, borders, or resting surfaces.

## Shapes

Zero radius, everywhere, without exception: buttons, code blocks, action line, tables, focus outlines are all perfectly sharp rectangles (`border-radius: 0`). The form language is ruled rather than shaped. Borders are always 1px solid Armature Line, never 2px, never dashed, never a different color. Clipping is a typographic device: the hero claim clips per line while typing (`white-space: nowrap; overflow: hidden`), and transcript lines reveal by clip-path so layout never shifts. The only curves in the system belong to the CRT material: the vignette's radial falloff and the scanline rhythm, both of which read as the glass tube itself, not as UI.

## Components

### Buttons
- **Shape:** sharp (0px radius), 1px border, monospace 13px label, no icons ever.
- **Primary (sponsor/checkout):** Phosphor Live background with Glass Night text (`padding: 10px 18px`, weight 700). Hover lifts to Bloom White background, still dark text. It is the only filled button in the resting state of the page.
- **Ghost (replay):** transparent with Armature Line border and Phosphor Dim text (`padding: 7px 15px`). Hover inverts hard: Phosphor Live fill, Glass Night text. No fades, no easing of the color itself.
- **Copy:** transparent with Armature Line border and Phosphor Live text (`padding: 3px 11px`). While copying, the `data-state="copied"` state flips to the filled Phosphor Live treatment, then reverts to the `copied` label before returning to `copy`.
- **Focus:** `2px solid #33ff66` outline at `2px` offset on every `:focus-visible`, on every control.

### Action Line (signature)
The hero's install command presented as a live shell line: Glass Deep fill, 1px Armature Line border, `padding: 0.9rem 1rem`, max 78ch. Left to right: a Phosphor Live `~/ace $` prompt, the Bloom White command in selectable horizontally-scrollable text, and a copy button. This is the page's primary CTA and it looks like input, not like marketing.

### Cards / Containers (code blocks)
- **Corner Style:** 0px. **Border:** 1px Armature Line. **Background:** Glass Deep.
- **Header:** a ruled-off strip (`border-bottom: 1px`, `padding: 0.5rem 0.9rem`, 13px Phosphor Dim) holding a filename left and a copy button right.
- **Body:** `padding: 1rem 0.9rem`, 14px line-height 1.6 Phosphor Read, horizontal overflow allowed.
- **Shadow Strategy:** none; recessed tone is the elevation.

### Tables (label grid and CLI rows)
Ruled like stock labels: `border-top: 1px` with a hairline under every row and `padding: 0.5rem 0`. Keys and descriptions are Phosphor Dim; values are Phosphor Read; commands inside rows are Bloom White. Tabular numerals keep columns honest.

### Transcript (signature)
The world's storytelling component: prompt lines in Bloom White with a Phosphor Live `$ ` prefix, output lines in Phosphor Dim with a 1.6ch hanging indent, `white-space: pre-wrap` and `overflow-wrap: anywhere` so typed text can never reflow the layout. Each finished output line plays the afterimage sweep once. A ghost `replay session` button sits below.

### Navigation (history rail)
- **Style:** fixed 15ch column, Glass Deep fill, hairline right edge, 13px entries.
- **States:** inactive = Phosphor Dim; hover = Bloom White; active = Phosphor Live with a `> ` prompt marker prepended. Entries truncate with ellipsis rather than wrap.
- **Mobile (≤900px):** becomes a sticky top bar, hairline bottom, horizontally scrollable, same state colors.

### Browser Surfaces
Selection inverts to Phosphor Live on Glass Night, the caret is Phosphor Live, the scrollbar track is Glass Deep with an Armature Line thumb (Phosphor Dim on hover), and focus-visible rings follow the button treatment. The world extends into the chrome of the browser itself.

## Do's and Don'ts

### Do:
- **Do** reserve `#33ff66` for live and actionable elements; read with `#6ccf95`, label with `#4aab73`, rule with `#1c4432`.
- **Do** theme the browser surfaces: selection, caret, scrollbar, and `:focus-visible` all belong to the world.
- **Do** draw structure with 1px `#1c4432` hairlines and 0px corners; let the band border be the vertical rhythm.
- **Do** cap reading measure at 72ch, transcripts and code at 80ch, and the sheet at 84ch.
- **Do** keep display type at or below 6rem with tracking no tighter than -0.04em (the claim uses -0.03em).
- **Do** author motion in one place, in seconds, and make reduced-motion render every element in its final state instantly.
- **Do** treat the CRT scanlines and vignette as world material: fixed, non-interactive, subtle enough that body text still passes contrast comfortably (worst measured pair 6.78:1).

### Don't:
- **Don't** add a second typeface, a kicker or eyebrow above headings, or emoji/glyph icons anywhere.
- **Don't** use gradient text, hard offset shadows, border-radius, or glow on headings and chrome.
- **Don't** put Phosphor Live behind large surfaces or on paragraphs; if it is everywhere, it means nothing.
- **Don't** let animated elements carry pre-applied `clip-path` (it zeroes the intersection rect and starves reveal observers) or animate layout-affecting width in transcripts; reveal by clip-path instead.
- **Don't** write copy that the product cannot back. The checkout gate stays honest: no fake pricing, no invented urgency.
