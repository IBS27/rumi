# Search agent

## Position in the pipeline

```
Main agent ---- style + color palette ----+
                                          v
Planner agent -- planned item ------> Search agent ---> ranked candidates
                                          |
                                   Exa -> page -> dimensions
```

The planner decides *what* the room needs and how much it may cost. The search agent
finds real, purchasable listings for one planned item and returns them ranked. It does
not talk to the user, does not place objects, and does not decide whether a proposal is
applied.

One call handles one category. The main agent calls it once per planned item.

## What it guarantees

Every returned candidate has a real merchant URL, a real price, and either dimensions
with recorded evidence or an explicit `unknown`. The agent never invents a number, and
never derives dimensions from an unscaled photo. A candidate whose dimensions are
unknown is still returned, ranked last, and flagged; the main agent decides what to do
with it.

## Input

`SearchTask`, as it exists today, plus one field:

```ts
palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
```

The palette comes from the main agent, not the planner, so the planner contract is
unaffected. `maxPriceCents` stays the only price field: there is no floor and no target.

## Output

```ts
export const rankedCandidateSchema = z.object({
  product: productSchema,
  score: z.number().min(0).max(1),
  breakdown: z.object({
    fit: z.number(),
    style: z.number(),
    color: z.number(),
    price: z.number(),
    completeness: z.number(),
  }),
});
export const searchTaskResultSchema = z.object({
  category: categorySchema,
  query: z.string(),
  candidates: z.array(rankedCandidateSchema),
  explanation: z.string(),
  failures: z.array(searchFailureSchema),
});
```

`breakdown` is returned so the agent can explain a pick and so a bad ranking can be
debugged without re-running the search. `failures` already reports, per stage, why
candidates were dropped.

## Pipeline

Cheap filters first. The only expensive stage is dimension resolution, so it runs last
and only on candidates that already passed everything else.

| # | Stage | Cost | Notes |
| --- | --- | --- | --- |
| 1 | Build the query and pick the retailer tier | free | `[styleTerms] [category]`, plus Exa `includeDomains` for the tier |
| 2 | Exa `/search`, 12 results | 1 call | Over-fetch: later stages discard a lot |
| 3 | Exa `/contents` | 1 call | Raise `maxCharacters`; request dimension-focused highlights |
| 4 | Extract price, variants, availability, images, color | 1 cheap model call per page, or free on Shopify | See *Merchant data* |
| 5 | Filter: availability, `maxPriceCents`, `excludeTags` | free | Existing `filterCandidates` |
| 6 | Score style, color, price; dedupe; sort | free | See *Ranking* |
| 7 | Resolve dimensions in rank order until K fit | up to 1 vision call each | See *Dimensions* and *Fill to K* |

### Retailer tiers

`maxPriceCents` selects the domain list passed to Exa as `includeDomains`, so a $60
ceiling and a $2,000 ceiling do not search the same shops:

| Tier | Ceiling per item | Domains |
| --- | --- | --- |
| value | under ~$150 | IKEA, Target, Wayfair, Amazon |
| mid | ~$150–800 | Article, West Elm, CB2, Burrow, Floyd, Room & Board |
| luxury | above ~$800 | Design Within Reach, RH, Lumens, Hay, Muuto, Herman Miller |

Keep the lists in `shared/search/retailers.ts` with the ceilings, so they are data and not
prose. Verify each domain against Exa once before trusting it. When a tier returns fewer
than 6 hits, retry without `includeDomains` and record a `search` failure noting the
fallback.

### Merchant data

When the host is Shopify — a 200 from `/products.json`, or `cdn.shopify.com` in the HTML —
take price, every variant, stock, SKU and image URLs from that JSON. These are the
merchant's own values, so they replace the model's reading of the page and remove the
worst error class: a sale price, a "from" price, or the wrong variant. Shopify does not
expose dimensions, so the dimension cascade still runs.

Otherwise extract those fields from the page text as today.

## Dimensions

### Order of resolution

| Page has | What runs | `evidence.kind` |
| --- | --- | --- |
| Full W/H/D in a spec field or JSON-LD | text parse only, no vision | `structured` or `spec-text` |
| Partial, e.g. width and height only | vision fills **only** the missing axis, and must agree within 10% on the known axes; disagreement discards the whole read | `mixed` |
| Nothing in text, a diagram image exists | vision only | `image` |
| Nothing anywhere | `dimensions: null`, `source: "unknown"` | `none` |

The partial case is also a free correctness test: a vision read that matches the page on
the axes we already know is trustworthy on the axis we do not.

### Units

Parse `"`, `in`, `ft`, `5'3"`, `cm`, `mm`, `m`. Require labeled axes; never trust the
order of `30 x 20 x 40`, because `W x D x H` and `W x H x D` are both common.

When no unit is printed, resolve it with the plausible-range table below: a 63-wide
wardrobe is plausible in inches and absurd in centimetres. If more than one unit lands
inside the range, record `unknown` rather than guessing. The merchant's country is a weak
tiebreaker only.

### Reading a dimension diagram

A product photo carries no scale and is never a source. A dimension diagram is different:
it is an image containing printed text. Only that second kind is read.

**Finding it.** Score images by filename and alt text against
`/dim|spec|measure|size|schematic|drawing/i`, with a bonus for gallery positions 2–5.
Send the top four as low-detail thumbnails in one classification call asking which show
printed measurements, then read the winner once at full detail. Do not downscale the
read: the annotations are small.

**Reading it.** A real diagram carries many measurements and only three are wanted. A
wardrobe diagram may print fifteen: shelf openings, drawer fronts, a hanging section, and
a detached drawer shown separately. So do not ask the model for the answer. Ask for every
measurement:

```ts
measurements: z.array(z.object({
  value: z.number().positive(),
  unit: z.enum(["in", "cm", "mm", "m", "ft"]),
  axis: z.enum(["width", "height", "depth", "unknown"]),
  subject: z.enum(["overall", "component", "unknown"]),
  label: z.string(),          // verbatim, e.g. '63"'
})),
hasPrintedMeasurements: z.boolean(),
```

Then select in code: **the overall dimension on each axis is the largest value on that
axis.** A component cannot exceed the whole product, so this holds even when the model
mislabels `subject`, and it correctly ignores a detached drawer drawn beside the cabinet.

Reject the read unless `hasPrintedMeasurements` is true and every measurement carries a
verbatim `label`. That rule is what stops a model from eyeballing a photo.

### Validation

A reading is discarded, not repaired, when any check fails:

- **Component sum.** Components along an axis should sum to slightly under the maximum.
  A sum that exceeds it means the axes were mixed up.
- **Variant ambiguity.** Two `overall` values on the same axis differing by more than 15%
  suggest two product sizes in one image. Fall back to text, or record `unknown`.
- **Plausible range**, in meters:

  | Category | Width | Height | Depth |
  | --- | --- | --- | --- |
  | bed | 0.70–2.20 | 0.20–1.60 | 1.60–2.30 |
  | desk | 0.60–2.40 | 0.60–1.30 | 0.40–0.90 |
  | lighting | 0.05–1.20 | 0.10–2.50 | 0.05–1.20 |
  | rug | 0.40–4.00 | 0.002–0.10 | 0.60–5.00 |
  | storage | 0.30–3.00 | 0.20–2.60 | 0.20–0.80 |
  | art | 0.10–2.50 | 0.10–2.50 | 0.01–0.15 |

- **Room bound.** A dimension larger than the room's matching axis is a bad read, not a
  large product.
- **Footprint.** `maxFootprint` is checked after resolution, allowing a 90° rotation, as
  `fitsFootprint` already does.

Resolved dimensions and their evidence are written to the `products` table, so the same
page is never paid for twice.

## Color

Exa cannot filter by color, so color is a score, not a filter, and an exact match is not
the goal: a piece only has to belong to the palette.

Resolve the product's color in this order, recording which was used:

1. **Variant name through a lexicon** — `Walnut`, `Cherry`, `Charcoal`, `Natural Oak` map
   to hex from a table in `shared/search/color.ts`. Free, deterministic, and it is what
   the merchant itself calls the finish.
2. **Vision fallback** on the main product photo for a dominant hex.

Score with OKLab, which is perceptually even and needs no dependency:
`color = 1 - normalize(min ΔE over palette entries)`. Minimum distance to *any* palette
entry, because a palette is a set.

## Ranking

Deterministic, in `shared/search/rank.ts`. Dedupe first — the same product listed by three
merchants must not fill the top three — by normalized title plus price proximity.

| Signal | Weight | Definition |
| --- | --- | --- |
| Fit | 0.30 | How well the footprint uses the allowed space. Near the target scores best; far below it is penalized; above the maximum was already eliminated. |
| Style | 0.25 | Overlap of `styleTerms` with title, tags, and product type. |
| Color | 0.20 | OKLab proximity, above. |
| Price | 0.15 | Rewards sensible use of the ceiling. Below ~20% of it, penalize: that is usually an accessory, not a bargain. |
| Completeness | 0.10 | `structured` dimensions beat `image` ones; known availability and real photos beat unknowns. |

Candidates with unknown dimensions rank below every candidate that has them.

An optional final pass hands the top five to the model for an aesthetic re-rank. Code
does the arithmetic; the model does the taste. The deterministic order is what ships if
that pass is cut.

## Fill to K

Filtering to three candidates and then discovering that none of them publish dimensions
leaves the room with a hole. So keep roughly 10–12 candidates after the cheap filters and
resolve dimensions in rank order, stopping once **K = 3** candidates fit. Skipping a
candidate costs nothing; resolving one costs at most a single vision read.

Per task: at most 3 vision-resolved products, at most 1 classification call plus 1
full-detail read each, and results cached by image URL.

## Modules

| Path | Contents |
| --- | --- |
| `shared/search/index.ts` | Exa client, query building, existing filters |
| `shared/search/retailers.ts` | Budget tiers to domain lists |
| `shared/search/jsonld.ts` | `parseProductJsonLd(html)` |
| `shared/search/shopify.ts` | `isShopify`, `mapShopifyProduct` |
| `shared/search/dimensions.ts` | Text parsing, units, plausible ranges, max-per-axis selection, reconciliation |
| `shared/search/images.ts` | Diagram-image shortlisting |
| `shared/search/color.ts` | Finish lexicon, sRGB to OKLab, palette proximity |
| `shared/search/rank.ts` | Dedupe, scoring, ordering |
| `convex/extract.ts` | Orchestrates the cascade and owns the model calls |
| `convex/search.ts` | The action: pipeline, fill-to-K loop, persistence |

Everything under `shared/search/` is pure and free of Convex imports, matching the split
already used there.

## Contract changes to agree with the main agent's owner

1. `measurementSchema` gains
   `evidence: { kind: "structured" | "spec-text" | "image" | "mixed" | "none", detail: string | null }`,
   where `detail` is the verbatim string or the image URL.
2. `searchTaskSchema` gains `palette: string[]`.
3. `searchTaskResultSchema` returns `candidates: RankedCandidate[]` in place of
   `products`, and adds `category` and `query`.

Update contracts, producers, consumers, fixtures, and tests together, per
[docs/contracts.md](contracts.md).

## Testing

No test may reach the network or a model provider.

- **Unit tests** cover the pure modules: unit parsing and the ambiguous-unit rule, the
  max-per-axis selection against a saved multi-measurement diagram, each validation
  check, OKLab distances, dedupe, and score ordering.
- **Recorded responses.** Vision and extraction responses are saved as JSON fixtures and
  replayed, so the cascade is testable end to end offline.
- **Golden set.** 15–20 real product pages saved as HTML, JSON and images, with
  hand-labeled dimensions. Report dimension hit rate, wrong-axis rate, and median error.
  Include at least three diagram-only listings and one page with a partial spec field.

### Acceptance criteria

- A page with a full spec table resolves dimensions with **zero** model calls.
- A diagram carrying 15 measurements resolves to the overall triple, not a component.
- A vision response with `hasPrintedMeasurements: false` yields `unknown`, never a guess.
- An unlabeled `63 x 70.9 x 18.9` resolves to inches for a `storage` item, and to
  `unknown` when both inch and centimetre readings are plausible.
- A product over `maxFootprint` is eliminated; the same product rotated 90° is kept when
  it then fits.
- The same product from three merchants appears once.
- A task whose first two candidates lack dimensions still returns K fitting candidates.
- `bun run typecheck`, `bun run lint`, and `bun test` pass.

## Out of scope

- Price floors, target prices, shipping, and tax.
- Mounting type and installation constraints, beyond `excludeTags`.
- 3D asset acquisition; `assetId` stays `null` here.
- Placement. The agent reports what fits, never where it goes.

## Open questions

- Should the aesthetic re-rank live here, or should the main agent do it with the
  `breakdown` values it already receives?
- When a tier falls back to the open web, should the result be marked so the UI can show
  that the price tier was not honored?
