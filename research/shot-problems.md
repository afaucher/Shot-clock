# Common shot problems and what a camera can see

Web research brief, 19 Nov 2026. Sources are mostly retailer guides and forums. Full pages weren't fetchable from the research environment, so claims rest on search-result text. Where the evidence is thin, it says so.

## What the app measures, and what it can't

| Measured | Not measured |
|---|---|
| Time from first drop to end; streams' start times | Weight, yield, ratio (no scale) |
| Each spout's colour over time, relative to itself (dark phase, caramel, paling, how steadily) | Pressure, temperature, taste |
| Left vs right: start times and how alike they develop | Absolute colour (depends on light, roast, freshness) |

Most sources treat **ratio** (e.g. 1:2, 18 g in and 36 g out) as the primary recipe variable. Time is "a symptom, not a cause" ([Clive Coffee](https://clivecoffee.com/blogs/learn/espresso-extraction-time-ratio-a-complete-guide-clive-coffee)). Without a scale the report can't check the ratio, so every report says so.

## Problems

| Problem | What it looks like | Timing | Likely causes | Fixes | From visuals alone |
|---|---|---|---|---|---|
| Fast flow / under-extraction | Pale early, little dark phase, early blonding, thin crema | Shot under about 20 s | Grind too coarse, low dose, channel ([CHB](https://completehomebarista.com/faqs/brewing-methods/espresso-technique/why-does-espresso-shot-run-too-fast/), [kaffeemacher](https://kaffeemacher.de/en/blogs/kaffeewissen/espresso-extraction-time)) | Finer grind, check dose. Don't fix speed with tamp pressure ([Clive](https://clivecoffee.com/blogs/learn/espresso-pulling-too-fast-how-to-slow-it-down-clive-coffee)) | Medium-high that it was fast. Under-extraction itself is a taste call |
| Slow flow / over-extraction | Thin, dark, dripping; slow to lighten | Over about 35–40 s | Grind too fine, high dose ([CHB](https://completehomebarista.com/guides/espresso-troubleshooting-complete)) | Coarser grind, lower dose | Medium-high that it was slow |
| Choked (drips only) | Never a continuous stream | Very late or no flow | Far too fine, overdosed, blocked screen | Much coarser, lower dose, clean the screen | High |
| Channeling | Spouted: one spout starts earlier, runs heavier or blondes first (mixing can hide it). Bottomless: off-centre drops, jets, pale spots ([SCG](https://www.seattlecoffeegear.com/blogs/learning-center/why-is-my-espresso-channeling)) | Sudden mid-shot jump in flow or lightening; often fast | Clumps, uneven distribution, unlevel tamp, poorly fitting basket ([Clive](https://clivecoffee.com/blogs/learn/distribution-the-primary-cause-of-channeling)) | WDT, level bed and tamp; check basket and screen | Medium (bottomless), low-medium (spouted) |
| Uneven spouts | One spout leads in start, thickness or lightening | Out of step from the start, or diverging later | **Machine not level** (check first), uneven puck, tilted tamp | Level the machine, then distribution and tamp | Medium that something is uneven; the cause is ambiguous |
| Early / abrupt blonding | Pale well before the expected end, suddenly rather than gradually | Steep lightening | Channeling, coarse grind, stale beans, very hot water ([Wild Kaffee](https://wild-kaffee.com/en/blogs/news/recognizing-espresso-blonding)) | Puck prep, then grind, then freshness | Medium; roast shifts the baseline |
| Spurting (bottomless) | Jets or spray from the edge | Early | Low-density spots, cracks, edge not sealed ([Papel](https://www.papelespresso.com/?p=36018)) | WDT to the edges, a tamper that fits | High on bottomless, rarely visible on spouted |
| Stale beans | Thin pale crema that fades; abrupt blonding | Often fast | CO₂ lost (sources put the cutoff anywhere from 2–3 to 5–6 weeks after roast) | Fresher beans | Low (looks like a coarse grind) |
| Very fresh beans | Big bubbly crema that collapses | Erratic | Roughly 1–4 days after roast | Rest the beans 5–14 days, longer pre-infusion | Low |
| Light roast | Paler throughout, blondes earlier or less obviously | Often longer targets (28–35 s, 1:2.2–1:3) | Denser, less soluble | Finer grind, hotter water | Context, **not a fault: don't flag** |
| Temperature | No reliable visual sign | – | Too cool tastes sour, too hot bitter | 1–2 °C steps, after grind and time | Very low: don't diagnose |

## A good shot over time

1. First drops a few seconds after the pump, up to about 9 s with pre-infusion, depending on the machine. Both spouts start together.
2. Dark, thick and honey-like ("mouse tail"), often tiger-striped ([Clive](https://clivecoffee.com/blogs/learn/what-is-espresso-supposed-to-look-like)).
3. Turns caramel and lightens gradually.
4. Blondes (pale, thinner, watery) shortly before the target yield.

Targets: the heritage SCAA definition is 20–30 s ([SCA](https://sca.coffee/sca-news/25-magazine/issue-3/defining-ever-changing-espresso-25-magazine-issue-3)). Many home baristas use 25–30 s, but ratio-first practice treats time only as a ballpark. Whether to cut at blonding or by weight is disputed ([H-B thread](https://www.home-barista.com/tips/when-to-end-espresso-extraction-weight-or-color-t66688.html)).

## Reliable vs unreliable cues

**More reliable:**
- total time and time to first drop, **against your own history**
- left/right asymmetry (machine level is a confounder)
- drips vs continuous flow
- spray on bottomless
- abrupt vs gradual lightening (in principle)

**Less reliable:**
- absolute crema or stream colour
- absolute blonding time
- tiger-striping as a quality signal: one analysis found little link to taste ([TDS](https://medium.com/data-science/tiger-stripes-in-espresso-are-signs-of-channeling-fb16775884c4))
- a clean-looking spouted stream (it hides channeling)
- temperature or freshness

## How the app's report uses this

| Note | Trigger (provisional) | Status |
|---|---|---|
| Ran fast / ran long | Shot under 20 s / over 35 s, only when the end was seen | in the report |
| Went light early, then stayed flat | ≥ 80% of a stream's lightening by 6 s, then paleness rising < 5 per 10 s | in the report (matches clip 1, which the owner called under-tamped) |
| Spouts out of step | First drops more than 1.5 s apart, both seen from the start | in the report |
| Spouts developed differently | Turned caramel > 3 s apart **and** paleness changed differently by > 12 | in the report |
| Turned pale suddenly | 3 s paleness jump | **measured, not a note**: it fired on the steadiest real shot (clip 2), because of colour-sampling noise |
| Drips only / spraying | Stream-shape detection | not implemented |
| Against your usual | Compare with your own history | not yet (needs a few shots of history) |

Every report ends with: without a scale, yield and ratio weren't checked; colour timing varies with roast and freshness; taste is the final judge.
