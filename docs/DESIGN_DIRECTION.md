# Design Direction (initial principles)

No visual identity is decided yet. These are the constraints any later design must meet.

- **Scientific visualisation over spectacle.** Brightness, colour and size encode measured quantities where possible. Artistic licence must be labelled.
- **Realistic lighting.** Stars are point sources with physically motivated brightness; no fake bloom that exaggerates magnitude.
- **Deep-space backgrounds.** Dark, low-saturation, no decorative gradients.
- **No generic sci-fi UI.** No neon outlines, no glowing panels, no decorative HUD.
- **Typography and layout.** Quiet, legible, high contrast. Measurements are shown with units and uncertainty.
- **Colour.** Reserved for encoding (e.g. temperature, classification). Light and dark themes both supported.
- **Honesty markers.** Hypothetical or model-based objects use a distinct, visible treatment.

The current interface (`index.html`, `src/ui/`) applies these principles to the star viewer and inspector: a near-black background, muted text, monospace numbers, thin rules, no glow or neon, and small OBS/DER/MOD tags that distinguish observed, derived and modelled values. Light theme and bloom are not implemented; stars are plain soft discs and no bloom is applied. The full visual identity remains undecided.
