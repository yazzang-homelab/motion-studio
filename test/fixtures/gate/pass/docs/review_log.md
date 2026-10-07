# Review log

## Round 1 — 9x16 — first full pass
SCORES: hook=6 readability=7 motion=6 variety=5 composition=7 brand=na sound=6
PROBLEMS:
1. [P0] [00:00.00] frame 0 is an empty background (metrics frame0)
2. [P1] [00:04.20] label overlaps the loader ring during the swap (strip.png)
3. [P1] [00:06.00–00:08.00] dead span after the chart settles (contact.png)
FIXES: none (first round)

## Round 2 — 9x16 — hook opens mid-action, swap timing
SCORES: hook=8 readability=8 motion=7 variety=8 composition=8 brand=na sound=7
PROBLEMS:
1. [P1] [00:07.68] counter lands with a hard digit flip (metrics pops)
2. [P2] [00:10.10] tagline 12 px outside the safe area (phone.png)
FIXES: frame 0 shows the partial headline; swapAlpha on the label

## Round 3 — 9x16 — counter on track(), sound pass
SCORES: hook=8 readability=9 motion=8 variety=8 composition=8 brand=na sound=8
PROBLEMS:
1. [P2] [00:11.50] tagline tracking slightly tight (phone.png)
2. [P2] [00:03.10] check mark could land one frame later
FIXES: counter uses track(); cues moved onto beats
