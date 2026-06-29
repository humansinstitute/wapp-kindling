# 01 — Scanning for Companies

This is the first stage of the Kindling pipeline: building the raw inventory of
professional-services firms we might one day want to talk to. The goal here is
**coverage, not quality** — we want to find every company that could plausibly
fit, and worry about filtering them later.

## What does the scanning

Scanning is run by a **Kindling Pipeline** with the role key `scan_target_list`
(the default pipeline is `kindling-scan-target-list`). Kindling itself doesn't
crawl the web — it hands a research brief to an Autopilot agent, which goes off
and searches, then writes the companies it finds back into our database.

A scan is kicked off in one of two ways:

- **Manually**, by asking for an industry + location + a target count.
- **Automatically**, by the Research Desk scheduler (see "Moving through the
  space" below), which keeps topping up the inventory on its own.

## How a scan is framed

Every scan is defined by three things:

1. **Industry** — e.g. "Legal", "Accounting", "Digital agencies".
2. **Location** — e.g. "Perth, WA".
3. **Target count** — how many companies we want from this slice.

The target count picks a **scan mode** that tells the agent how hard to dig:

| Target count | Scan mode     | Intent                          |
|--------------|---------------|---------------------------------|
| under 100    | `interactive` | quick, focused look             |
| 100–499      | `batch`       | a solid pass over the segment   |
| 500+         | `bulk`        | exhaustive sweep                 |

## Defaults and "knowing what we already have"

Before each scan we build a **scan context** so the agent doesn't repeat work.
This context includes:

- How many companies we already hold for this industry/location, how many have
  websites, and how many are possible duplicates.
- Our broader coverage (which industry/location combinations are well-covered
  and which are thin).
- The 25 most recently touched companies in that slice.
- The **strategies we've already tried** (and which ones are planned next), so
  the agent searches new angles instead of re-running the same queries.

Segments also carry their own defaults — a default geography, a default target
count (100), a default batch size (25), and per-segment "coverage targets"
(how many companies we ultimately want to find there).

## Moving through the space of professional services

We don't scan one giant list. The available universe is broken into
**coverage slices**. A slice is a unique combination of:

```
segment (industry)  ×  geography  ×  source family  ×  search strategy
```

where **source family** is where the leads come from — `web_search`,
`directory`, `association`, `registry`, `social`, or `maps`.

Each slice tracks two numbers: its **target count** (how many companies we want
from it) and its **current count** (how many real, source-backed, unique
companies we've actually found). The gap between those two is the slice's
**deficit**.

The Research Desk scheduler walks these slices automatically:

- It looks for slices whose inventory is still below target and isn't on
  cooldown, and runs the next scan against the one with the biggest, most
  worthwhile gap.
- Slices that keep coming back empty or blocked are flagged **low-yield** and
  pushed onto a longer cooldown, so we stop wasting effort on dead ends and
  spend it where companies are actually being found.

The result is that we steadily "fill in" the map — segment by segment, suburb by
suburb, source by source — instead of hammering one query and missing whole
corners of the market.

## What comes out

Discovered companies land in the database with a `data_ring` of **`found`** (the
first rung of the ladder), along with the sources that backed each discovery and
a log of every search strategy that was attempted. From here they're ready for
**Enrichment** (see `02_Enrichment.md`).
