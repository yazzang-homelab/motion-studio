---
type: llm
weight: 2
---

The user asked for an XML-tagged spec prompt for a UI-morph product loop for an invoicing app named Tallyo, with no code.

The rules a good spec states:
1. One container or shape never cuts: every state is the same element changing size, corner radius and fill, with its content swapping inside it.
2. A cursor drives each state change with a real action such as a click, hover or typing.
3. State changes are timed to the music, on beats or downbeats of a stated tempo (for example 120 BPM).
4. The loop is seamless: the last frame equals the first, including the cursor's position and motion.
5. Before any code, Claude must ask for the inputs (such as product details, the real UI states and data, brand colors and fonts, music) or show the state list for approval.

PASS if the spec states at least four of the five rules AND names a concrete sequence of Tallyo-specific states (for example invoice card, amount field, send button, loader, paid check).
FAIL if two or more rules are missing, if the states are generic placeholders with nothing about invoicing, or if the reply is mostly implementation code instead of a spec.
