---
description: A liquid-chrome SDF title loop request should route to gl-scenes and plan one distance field with smooth-min morphs, chrome shading and a periodic, deterministic shader driven only by the seek time
tags: [smoke, trigger]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: Plan or code for a glLayer fragment shader that raymarches one SDF scene, merges/splits blobs and an extruded word with smooth-min, shades chrome with Fresnel and a studio environment, takes time only from uniforms and loops with whole cycles
---

In my motion-studio project I want a 6-second square loop: a liquid chrome blob breathes, squashes, splits into seven droplets that morph into the word "OPUS", holds while reflections slide over it, then melts back into the blob so the end matches the start exactly. How would you build this so every frame is deterministic and the morph never pops?
