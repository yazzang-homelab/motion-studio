# Storyboard: <film title>

<!--
Template for long films (chapters). The director writes it after docs/style_guide.md and before
docs/ANIMATION_GUIDE.md, then revises it after the first full pass, when you know what actually works on screen.
Each chapter animator reads its own chapter section. Replace every <...> and delete these comments when done.
Times are film seconds taken from the beat grid: bar(n) = downbeat n, beat(n) = beat n, both counted from 0.
-->

## The idea

<One paragraph: what happens, the turn, how it ends. Name the bookend (how the last image answers the first) or the
twist that reframes everything before it.>

## Rules for every shot

- Something happens in every shot: an event the viewer notices, not a pose.
- Text on screen: <e.g. a handful of huge words on downbeats; no labels or captions that repeat the voice-over>.
- <film-specific rule>

## Cast and elements

| Who or what | Look (see style guide) | Role in the story | Identity lock | Module |
|---|---|---|---|---|
| <hero> | <shapes, colors> | <what it wants, how it changes> | <never changes: silhouette, key colors> | `film/scenes/shared_hero.js` |
| <prop that behaves like a character> | <...> | <escalates across chapters: values or states per chapter> | <...> | <...> |

## What ties it together

- Sets: <one place per chapter; returning sets come back escalated>
- Transitions: <how chapters hand over: motivated wipes, action carried across the cut>
- Motif: <a recurring shape, color or sound>
- Camera: <the camera language; a move in every shot or deliberate holds>
- Palette arc: <how color changes from the first chapter to the last>

## Chapters

<!-- One section per chapter. "Out" is how the shot hands over to the next one. Owner = the chapter-animator
subagent or "main" for the director. Keep chapters 8 to 30 s. -->

### 01 · <name> · <from>-<to> s · bar(<a>) to bar(<b>) · <palette words> · owner: <chapter-animator | main>

| Time (s) | Grid | Shot | What the viewer notices | Text on screen | SFX | Out |
|---|---|---|---|---|---|---|
| 0.00-2.00 | bar(0) | <hook: the single most striking image> | <the event> | <exact text or none> | thump @ bar(0) | <cut on action> |
| 2.00-4.00 | bar(1) | <...> | <...> | <...> | whoosh @ bar(1) | <...> |

### 02 · <name> · <from>-<to> s · bar(<a>) to bar(<b>) · <palette words> · owner: <...>

| Time (s) | Grid | Shot | What the viewer notices | Text on screen | SFX | Out |
|---|---|---|---|---|---|---|
| <...> | <...> | <...> | <...> | <...> | <...> | <...> |

## Self-check before handing out chapters

- [ ] Every shot has an event, not only a pose.
- [ ] Every read lands before the next beat that changes it.
- [ ] Every seam has a planned transition (no empty Out cell).
- [ ] The first 2 s carry the hook, and frame 0 already shows content.
- [ ] Something new happens every 2 to 4 s across the whole film.
- [ ] The ending rhymes with the opening, or loops into it.
- [ ] Text appears only where the rules above allow it.
- [ ] Every chapter starts and ends on a downbeat.
