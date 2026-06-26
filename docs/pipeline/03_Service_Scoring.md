# 03 — Service Scoring

Once a company is enriched, we ask the question that decides whether it's worth
pursuing: **how well does this firm fit what we sell?** Scoring answers that with
a single number, a tier, and the evidence behind it.

## What we score against

We score each company against our **service offering** — **Adapt Lumia**, the
coaching-plus-platform service aimed at owner/principal-led professional-services
SMEs (the sweet spot being roughly 20–200+ employees). The offering, together
with the current **market profile** version, defines what "good fit" means, so
that scores stay consistent as our positioning evolves.

## What does the scoring

Scoring is run by a Kindling Pipeline with the role `score_company_service_fit`
(pipeline `kindling-score-company-service-fit`). It's given the full enriched
picture — the company profile, its sources, its signals, and the active service
offering — and asked to judge the fit.

## How a company is scored

The pipeline rates each company on the **same set of dimensions** every time, so
two companies can be compared fairly. The dimensions reflect what makes a firm a
good Lumia client:

| Dimension                          | What it measures                                              |
|------------------------------------|--------------------------------------------------------------|
| `owner_dependency`                 | How much the business routes through one owner/principal.    |
| `leadership_complexity`            | Whether there's a real leadership team with role friction.   |
| `handover_or_succession_pressure`  | Evidence of succession, exit, sale or generational handover. |
| `scale_or_operating_rhythm_pressure`| Growth, multi-office, hiring, delegation strain.            |
| `sme_size_and_complexity`          | Whether headcount/complexity sits in our sweet spot.         |
| `evidence_quality`                 | How well-corroborated the underlying enrichment is.          |

Each dimension gets its own 0–100 score with a written reason. These roll up
into:

- An **overall score** from **0 to 100**.
- A **confidence** (0–1) reflecting how solid the evidence is.
- A short **fit explanation**, the **caveats** (what would weaken the case), a
  **recommended action**, and an **outreach angle seed** — a first draft of the
  hook we'd lead with if we reached out.

It also notes the suggested **entry point** into the service (e.g. starting with
*Lumia Design*).

## The tiers: High / Medium / Low

The overall score maps to one of three **bands**, which drive the High / Medium /
Low tabs in the Scored view:

| Band       | Score range |
|------------|-------------|
| **High**   | 75–100      |
| **Medium** | 50–74       |
| **Low**    | 0–49        |

In plain terms:

- **High** — clear fit; advance toward outreach.
- **Medium** — a real but qualified fit (often a good firm with no live trigger
  yet); worth a careful, low-pressure approach.
- **Low** — poor fit (too small, wrong shape, weak evidence); deprioritise.

## Ranking and the call list

Scoring a company moves it up to the `scored` ring. Across the whole database,
scored companies are then **ranked** and the best ones are rolled up into a
**top-targets** list, filtered by band. That ranked list is what feeds the final
stage — **Outreach** (see `04_Outreach.md`).
