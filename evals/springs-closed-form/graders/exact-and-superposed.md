---
type: llm
weight: 2
---

The user asked for a closed-form damped spring in JavaScript that is exact for under-, critically- and over-damped settings (their heavy preset k=90, d=20 has a damping ratio of about 1.05, so it is overdamped), and for a way to animate a value that retargets at several times without restarting or simulating.

PASS if all of these hold:
1. The spring is a pure function of t (no loop over time steps, no stored velocity between calls) built from Math.exp with Math.cos or Math.sin for the underdamped case.
2. The overdamped case (damping ratio above 1) has its own formula with two real exponential rates, for example r1,2 = -z*w0 ± w0*sqrt(z*z - 1), or an equivalent sinh/cosh form. Reusing the critically damped formula for every damping ratio of 1 or more does NOT count.
3. The retargeting value is computed as the start value plus the sum of one spring per change, each weighted by that change's delta and started at its own key time (a track() or superposition function), not by restarting a spring from the current value.

FAIL if any of the three is missing or wrong.
