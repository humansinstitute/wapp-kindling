# 02 — Enrichment

Scanning gives us a name, an industry and a location. **Enrichment** turns that
thin record into a real profile we can score and write outreach against. The
single most valuable thing it produces is **named decision-makers and how to
reach them** — that's the prize the whole pipeline is built around.

## What does the enrichment

Enrichment is run by Kindling Pipelines in two shapes:

- **One company at a time** — role `enrich_company`, pipeline
  `kindling-enrich-company`. Used when you want to deepen a single firm on
  demand.
- **A whole industry in a batch** — role `enrich_industry_segment`, pipeline
  `kindling-enrich-industry-segment`. This is what the automated loop uses.

### The automated batch loop

The auto-enrichment job (`src/auto-enrichment-job.ts`) works through the backlog
industry by industry:

1. It picks the **next industry** that has the most un-enriched companies (and
   hasn't just been worked).
2. It pulls a batch of up to **21 companies** from that industry.
3. It sends the whole batch to the `kindling-enrich-industry-segment` pipeline
   in one go, with a write-back URL so results can be saved company-by-company
   as they're found.

This is deliberately steady rather than fast — the loop is throttled (on the
order of every ~30 minutes) so we make consistent progress without overloading
the research agent or hitting rate limits.

## The five areas of focus

Every company is researched against the same five **enrichment strategies**.
Together they tell the agent both *what* to find and *how* to look:

| Strategy key         | What we're trying to find                                                                 |
|----------------------|-------------------------------------------------------------------------------------------|
| `official_website`   | The firm's real website — services, operating areas, and public contact paths.            |
| `search_results`     | Independent search results / directories that corroborate the firm and offer other URLs.  |
| `blog_news_resources`| Blogs, news, publications, case studies — signals of which practice areas are active.      |
| `people_team`        | **The decision-makers.** Named senior people and how to contact them.                      |
| `fit_signals`        | A summary of service-fit signals, operating complexity, visible gaps and caveats.          |

### The decision-maker hunt (the important one)

The `people_team` strategy is where the high-value work happens. The agent is
told to:

- Crawl the pages where leaders actually appear — `/our-people/`, `/team/`,
  `/about/`, and individual staff profile pages.
- Identify **named** directors, MD/CEO, owners, and heads of practice — not just
  a generic `info@` address.
- For each person, capture their **name, title, direct business email, phone /
  mobile, and LinkedIn URL**, and **infer the email pattern** for the firm
  (e.g. `firstnamelastname@domain`) so we can reach people whose address isn't
  published.
- Return these as a structured `decisionMakers` list, and raise one signal per
  person of type `decision_maker_contact`.

This is the output the rest of the pipeline depends on: you can't write good,
personal outreach to a firm if all you have is a contact form.

## How findings are stored

Enrichment writes back into the company's **profile** (summary, services, team
size, leadership, the `decisionMakers` list, fit signals and caveats), plus:

- **Sources** — each URL the agent used, with a confidence score.
- **Signals** — notable events or facts (hiring, expansion, succession hints,
  and the `decision_maker_contact` entries above).
- A **confidence score** (0–1) for how well-corroborated the profile is.

As a company is enriched it moves up the `data_ring` ladder from `found` toward
`enhanced`, and is then ready for **Service Scoring** (see
`03_Service_Scoring.md`).
