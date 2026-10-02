# Art brief: new mech frames

The bay already sells weight through code: per-chassis gaits, footfall dust and camera shake, landing squash, glows, sparks, and shadows. What code cannot do is paint new poses. The shipped walk cycles are four generated frames, and some barely differ (Atlas frames 0 and 1 are identical, Catapult's four are within a few percent). New frames are the single biggest visual upgrade left.

## What to make, in priority order

1. **8-frame walk cycles** for all five mechs, same camera and facing as today. Drop-in: no code changes.
2. **Back-facing walk cycles** (the mech walking away, up-screen). Today a mech walking north shows its front, which reads as walking backwards. Needs a small code change to pick a row by heading.
3. **Working loop** (2–4 frames): arm or weapon raised, scanning, or tooling at the facility. Replaces the current gentle sway while a mission runs.
4. **Damaged idle**: scorched, sparking, one arm limp. Replaces the gray tint on a failed mission.
5. **Facility "active" variants**: the same buildings with lights on, for linked and working states.

## Technical spec

- **View:** isometric 3/4 (2:1 dimetric), camera above and in front, matching the existing art. Light from the upper left.
- **Facing:** front-right (the mech's front toward the lower right of the image). Left-facing art also works; flip it with `flipIdle` / `flipWalk` in `MECH_SPECS` (`scripts/sprite-forge.ts`).
- **Background:** real transparency. If the generator can't do that, use flat magenta `#FF00FF`, which the forge strips. Avoid checkerboard "transparency"; it gets trapped between legs and arms.
- **Framing:** whole mech in frame, feet visible, no ground shadow (the game draws its own), one mech per image, same scale in every frame.
- **Walk strips:** square cells side by side in one PNG, any cell size (256 or 512 is plenty) and any frame count. Contact frames should be the first and the middle frame (frame 0 and frame 4 of 8).
- **Style:** keep the current look. Dark gunmetal armour with worn edges, orange hazard striping, cyan status lights, amber or yellow cockpit glass, clean dark outline, crisp high-detail pixel-art shading.

## Pipeline

1. Save the idle art as `assets/mechs/<class>-poc.png` and the walk strip as `assets/mechs/walk/<class>-walk.png` (`<class>` is `atlas`, `marauder`, `raven`, `catapult`, or `locust`).
2. If a frame faces left, set its flag in `MECH_SPECS`. If a background pocket survives, trace it in `POCKETS`.
3. Run `npm run forge:sprites`. It cleans the frames, flips them, sizes them by weight class, and writes `assets/mechs/sheets/<class>.png` plus HUD portraits.
4. Run `npm run demo` and deploy the mech. Longer cycles are picked up automatically; stride timing stays the same.

## Tools

- **Gemini image generation** made the original set. Using it again, with the current idle art attached as a reference, is the easiest way to stay on-model.
- **PixelLab** (pixellab.ai) is built for game sprites. It can rotate a character to new facings and animate it with a consistent look, which suits the walk cycles and back views.
- **Retro Diffusion** is a pixel-art image model. Good for the facility variants.
- **A pixel artist** gives the best result for the hero animations if the budget allows.

## Prompt starters

Shared suffix for every prompt: _isometric 3/4 view, facing front-right, full body with feet visible, dark gunmetal armour with worn edges, orange hazard stripes, cyan status lights, crisp high-detail pixel art with a clean dark outline, lit from the upper left, no ground shadow, transparent background._

| Mech     | Chassis                                                                                   | Walk feel                                  |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| Atlas    | 100-ton assault mech: huge rounded shoulders, skull-like visor with amber eyes, fists     | Slow, heavy strides, torso barely rotates  |
| Marauder | 75-ton heavy mech: angular torso with a vented chest, long gun barrels on both forearms   | Measured, deliberate, guns held level      |
| Catapult | 65-ton support mech: squat body, two boxy missile racks as shoulders, bird-like legs      | Rolling waddle, racks bob with each step   |
| Raven    | 35-ton recon mech: tall reverse-jointed legs, amber sensor head, antenna masts            | Quick, springy, head stays level           |
| Locust   | 20-ton scout: small cockpit pod with yellow eyes, spindly reverse-jointed legs            | Fast skitter, short steps                  |

For a walk strip, add: _8-frame walk cycle, horizontal sprite strip, frames evenly spaced in square cells, first and fifth frames are foot-contact poses._
