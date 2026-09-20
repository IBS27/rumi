# Search agent

## Position in the pipeline

```
Main agent (plans the room, owns the conversation)
     |  one SearchTask per category: query, ceiling, footprint, style, palette
     v
Search agent ──> Exa ──> pages ──> dimensions ──> ranked candidates
```

The main agent decides what the room needs and what each item may cost. The search agent
finds real, purchasable listings for one category and returns them ranked. It does not
talk to the user, does not place objects, and does not decide whether a proposal is
applied. There is no separate planner: the main agent owns that.

## What it guarantees

Every returned candidate has a real merchant URL, a real price, and either dimensions
with recorded evidence or an explicit `unknown`. The agent never invents a number and
never derives dimensions from an unscaled photograph. A candidate whose dimensions are
unknown is still returned, ranked below every sized candidate, and flagged.

## Input

`SearchTask`:

```ts
{ query, category, maxPriceCents, maxFootprint: {width, depth} | null,
  maxHeight: number | null, styleTerms: string[], palette: string[],
  miscellaneous: string[], excludeTags: string[] }
```

`maxPriceCents` is the only price field: no floor, no target. Use `0` when the user
has not specified a budget; that disables the price ceiling. `miscellaneous` is required,
even when empty, and holds up to twelve additional requested specifications. These
phrases influence retrieval and ranking; a match is verified only when the page supports it.
`styleTerms`, `palette`, and `miscellaneous` are soft preferences. Price, size,
availability, and `excludeTags` are checked in code.

`palette` is a list of hex
values from the main agent; colour is scored against it, never filtered by it. `category`
is an open string supplied by the main agent, not a bedroom-only enum. The `query` names
the actual item to retrieve, such as `wishbone dining chair` or `outdoor side table`.

## Output

`searchProducts` answers one task. The internal `searchCategories` action answers up to
eight at once, three at a time. Each action returns at most one candidate per task.
The main agent currently exposes only `searchProducts` in its tool set.

```ts
{ category, query, candidates: RankedCandidate[], explanation, failures: SearchFailure[] }

RankedCandidate = { product: ProductCandidate, score: 0..1,
                    breakdown: { fit, style, color, price, completeness } }
```

`breakdown` lets the main agent explain a pick and lets a bad ranking be debugged without
re-running the search. `failures` records, per stage, why candidates were dropped.

## Pipeline

Cheap signals filter first. The one expensive stage — reading a dimension drawing — runs
last, on ranked survivors, and only until enough candidates fit.

| #   | Stage                                                      | Cost                    | Notes                                                                                                      |
| --- | ---------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Query and cumulative retailer catalogue                    | free                    | `[styleTerms] [query] under $X`; larger budgets retain all cheaper stores                                  |
| 2   | Search the retailer catalogue                              | 1 call                  | Hits are round-robined by merchant; thin or single-store results trigger an open-web search                |
| 3   | Rendered contents, plus a direct fetch of the markup       | 1 call + N cheap GETs   | See _Reading a page_                                                                                       |
| 4   | Merchant data: Shopify JSON, then JSON-LD                  | free                    | Replaces a model for price, variants and stock                                                             |
| 5   | Model extraction, only for what merchant data left missing | ≤ 1 cheap call per page | Skipped entirely when the merchant answered                                                                |
| 6   | Cheap dimension stages                                     | free                    | Structured data, then the page specification                                                               |
| 7   | Filters, dedupe, ranking                                   | free                    | Availability, price, partial-word exclusions and size; colour remains soft                                 |
| 8   | Diversify merchants, then read drawings until K fit        | ≤ 3 vision calls        | The first choices use different merchants where possible; `resolveToFit` handles the dimension-read budget |

The catalogue spans mass retailers and furniture specialists: IKEA, Target, Walmart,
Wayfair, Home Depot, Lowe's, Costco, World Market, AllModern, Joss & Main,
Article, West Elm, CB2, Burrow, Floyd, Room & Board, Crate & Barrel, Pottery Barn,
Joybird, Castlery, Rugs USA, Ruggable, Lamps Plus and others. Price tiers are cumulative,
so a $900 ceiling searches value and mid-tier stores. If fewer than two merchants
surface, fewer than six hits arrive, or fewer than two surviving merchants publish usable dimensions, the open web
is queried to discover stores outside the catalogue, including independent Shopify
storefronts. Amazon is excluded because its indexed product URLs did not reliably open
for users.

### Reading a page

Retail pages are rendered in the browser. A raw fetch of a live IKEA, Article or Floyd
product page returns navigation, promotions and footer badges: the gallery and the
specification are not in the markup, and one of those pages published only an
`Organization` JSON-LD block. Wayfair and CB2 refused the request outright.

So **rendered content is the primary source**, and the raw markup is kept only for what
rendering strips: JSON-LD blocks and the storefront fingerprint. Images scraped from raw
markup are filtered to those whose URL or alt text carries a whole word from the product
slug, which is what separates a gallery photograph from the site's own banner.

### Merchant data

When the host is Shopify — `cdn.shopify.com` in the markup, or a valid response from
`/products/{handle}.json` — price, every variant, stock and image URLs come from that JSON. These
are the merchant's own values, so they replace a model reading a page and remove the
worst error class: a sale price, a "from" price, or the wrong variant. Variant selection
prefers in-stock options within the ceiling, ranks them by palette proximity, and breaks
ties by price. If that pool is empty it considers other in-stock variants, then all
variants; the later hard filters still reject unavailable or over-budget products.
Shopify does not publish dimensions, so the cascade still runs.

Otherwise a model reads those fields from the page text. That prompt names no price
ceiling: told one, the model suppressed a $6,795 listing instead of reading it, and the
ceiling is applied in code anyway. A listing the model still cannot name takes its name
from the page title, which is the product then the shop.

## Dimensions

### Order of resolution

| Page has                                  | What runs                                                                                                                | `evidence.kind` |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------- |
| Full W/H/D in structured merchant data    | text parse only, no vision                                                                                               | `structured`    |
| A specification printed in the page text  | text parse only, no vision                                                                                               | `spec-text`     |
| Part of a specification                   | vision fills only the missing axes, and must agree within 10% on the known ones; disagreement discards the whole diagram | `mixed`         |
| Nothing in text, a drawing in the gallery | vision only                                                                                                              | `image`         |
| Nothing anywhere                          | `dimensions: null`, `source: "unknown"`                                                                                  | `none`          |

The partial case doubles as a correctness test: a diagram that matches the page on the
axes we already know is trustworthy on the axis we do not.

### Reading text

- Units: `"`, `in`, `ft`, `cm`, `mm`, `m`, `5'3"`, and printed fractions such as
  `31 1/2"`, which US retailers use everywhere.
- Axes must be labelled. `30 x 20 x 40` is refused unless the page states its own order,
  as in `(W x D x H)`, because `W x D x H` and `W x H x D` are both common. IKEA's static
  markup prints exactly this unordered form, and the agent declines it rather than
  guessing: the drawing stage is what rescues that page.
- A line stating all three axes is preferred over measurements scattered through a page,
  which are usually parts. A statement that fails the plausible range — a shipping box
  printed without the word, `8"H x 8"W x 31"L` for a rolled rug — does not end the
  reading; the next candidate line is tried.
- Two categories state their size as a pair by convention, and both can turn a quarter,
  so the pair is read: a rug's `2.5' x 8'` is width by length, completed by its pile
  height; a print's `16" x 23"` is width by height, completed by a frame depth. A print
  whose page never states a depth stays incomplete rather than guessed — the majority of
  wall art, which is the open contract question below.
- A round piece states a diameter, which is read as width and depth at once. "Length" is
  read as depth for rugs and beds only; elsewhere it is too ambiguous to use.
- Rendered text is turned into lines at block ends before parsing. Collapsing it merged
  lines, so one packaging note took a page's whole specification with it.
- Lines mentioning packaging, shipping or cartons are dropped: the box is bigger than the
  product. So are filter menus, which advertise ranges and result counts
  (`Width 72" to 86" (88)`) that read exactly like measurements.
- A measurement with no printed unit is resolved by asking which unit puts every axis
  inside the category's plausible range. Exactly one answer means the unit is known; two
  answers mean it stays unknown.

### Showcase-image dimension extraction

When a listing has no complete dimensions in structured data or page text, the agent
must inspect the listing's own product-gallery images. It downloads the image bytes
before the vision call; it does not ask the model to follow an image URL or infer scale
from the furniture's appearance.

The vision prompt has a hard no-guessing rule: it may return only measurements whose
numbers are visibly printed in the image. It reports all printed measurements with
their labels, axis, unit, and whether each is an overall product measurement or a
component measurement. Code then selects one consistent overall width, height, and
depth, rejects conflicting or implausible readings, and records `evidence.kind` as
`image` (or `mixed` when text supplied some axes). If the showcase contains no printed
measurements, the result is `dimensions: null`, `source: "unknown"`.

This means a diagram such as a wardrobe product-size image can produce the overall
dimensions while ignoring drawer, shelf, opening, and leg measurements. A normal hero
photograph without printed labels cannot produce dimensions.

Acceptance checks:

- product-gallery images are considered even when their URL or alt text is generic;
- image bytes are passed to vision, not an unverified remote URL;
- printed labels are copied verbatim and converted to metres by the shared parser;
- ordinary photographs and images without printed measurements return `unknown`;
- a diagram that disagrees with known page dimensions is discarded rather than guessed.

The implementation lives in `convex/extract.ts`, `shared/search/images.ts`, and
`shared/search/cascade.ts`; the no-text/image-only and contradiction cases are covered
by `tests/cascade.test.ts` and `tests/extract.test.ts`.

### Reading a drawing

A product photograph carries no scale and is never a source. A dimension drawing is
different: it is an image containing printed numbers.

**Choosing the image.** Anything under about 400 pixels is skipped first — a
100-pixel thumbnail was once sent to be read. Images are scored on a name match
(`dimension|spec|measure|size|schematic|drawing`), a bonus for sitting just after the hero
shot, and a larger bonus for being last in the gallery, which is where drawings usually
sit when nothing is named. A named drawing is read alone; otherwise the best two are sent
together.

**Reading it.** A real drawing carries many measurements and only three are the product:
a wardrobe drawing prints fifteen — shelf openings, drawer fronts, a hanging section, and
a detached drawer beside the cabinet. So the model is never asked for the answer. It
enumerates every measurement it can see:

```ts
{ value, unit, axis: width|height|depth|unknown,
  subject: overall|component|unknown, label /* verbatim, e.g. 63" */ }
```

and code selects: **the overall size on an axis is the largest value on that axis**. A
part cannot exceed the whole, so this holds even when the model mislabels `subject`, and
it ignores a drawer drawn separately. The reading is refused unless the model reports
printed measurements and every entry carries a verbatim label.

### Validation

A reading is discarded, never repaired, when:

- Two `overall` values on one axis differ by more than 15%, which means the image shows
  two product sizes.
- An axis is missing.
- The triple falls outside the category's plausible range, in meters:

  | Category | Width     | Height     | Depth     |
  | -------- | --------- | ---------- | --------- |
  | bed      | 0.70–2.20 | 0.20–1.60  | 1.60–2.30 |
  | desk     | 0.60–2.40 | 0.60–1.30  | 0.40–0.90 |
  | lighting | 0.05–1.20 | 0.10–2.50  | 0.05–1.20 |
  | rug      | 0.40–4.00 | 0.002–0.10 | 0.60–5.00 |
  | storage  | 0.30–3.00 | 0.20–2.60  | 0.20–0.80 |
  | art      | 0.10–2.50 | 0.10–2.50  | 0.01–0.15 |

Categories outside this tuned set use broad physical sanity bounds. The search remains
available for any item named by the main agent, while unitless measurements stay unknown
unless exactly one unit interpretation is safe.

- It contradicts what the page text already said.

A sum check over the component measurements was tried and dropped: parts overlap, so they
double-count and a valid reading fails it. The largest-per-axis rule does not need it.

`maxFootprint` and `maxHeight` are applied after resolution, allowing a quarter turn.

## Colour

Exa cannot filter by colour, so colour is a score and an exact match is not the goal: a
piece only has to belong to the palette. Colour is resolved from the variant or finish
name through a lexicon — `Walnut`, `Cherry`, `Natural Oak`, `Brushed Brass` — which is
free, deterministic, and what the merchant itself calls the finish. Distance is measured
in OKLab, which is perceptually even, against the closest palette entry. An unread colour
gets a neutral score rather than being treated as literal grey. Colour contributes only
10% of the rank and is never a filter.

## Ranking

Deterministic. The same product listed by several merchants is folded together first, by
normalised title and price proximity, so it cannot fill the whole result.

| Signal       | Weight | Definition                                                                                                    |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| Fit          | 0.30   | How much of the allowed footprint the piece uses. Far below it is penalised; above it was already eliminated. |
| Style        | 0.30   | Overlap of `styleTerms` and `miscellaneous` with title, tags and variant.                                     |
| Colour       | 0.10   | OKLab proximity to the palette; unread colour is neutral.                                                     |
| Price        | 0.15   | Rewards sensible use of the ceiling; below a fifth of it, penalised as an accessory.                          |
| Completeness | 0.15   | `structured` dimensions beat `image` ones; known stock and real photographs beat unknowns.                    |

Candidates without dimensions rank below every candidate that has them. Product identity
comes from the main agent's query and the search provider; there is no bedroom-specific
type dictionary that can block a new category.

## Fill to K

The ranked list is walked until the configured number of candidates fit, with at most
three vision reads per task. The default target is **K = 1**. Offline callers can override
the pipeline target; both Convex search actions cap their returned candidates at one.
If no sized candidate survives, an unresolved candidate may be returned with unknown
dimensions. Skipping a candidate costs no vision call.

## Modules

Everything under `shared/search/` is pure, free of Convex imports, and tested offline.

| Path                | Contents                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| `index.ts`          | Exa client, query building, hard filters, `resolveToFit`, result building |
| `pipeline.ts`       | `runSearch`: the whole flow, with its dependencies injected               |
| `page.ts`           | Direct page fetch, HTML to text, image extraction                         |
| `jsonld.ts`         | schema.org Product parsing                                                |
| `shopify.ts`        | Storefront detection and product JSON mapping                             |
| `listing.ts`        | Merchant data to listing facts, variant choice                            |
| `candidate.ts`      | Layering facts by trust, colour resolution, building a `ProductCandidate` |
| `cascade.ts`        | Dimension resolution, cheapest stage first                                |
| `dimensions.ts`     | Units, fractions, plausible ranges, largest-per-axis selection, merging   |
| `images.ts`         | Drawing shortlist, read targets, slug relevance                           |
| `color.ts`          | Finish lexicon, sRGB to OKLab, palette proximity                          |
| `rank.ts`           | Dedupe, scoring, ordering                                                 |
| `retailers.ts`      | Price tiers to domain lists                                               |
| `convex/search.ts`  | Keys, models, persistence. Thin.                                          |
| `convex/extract.ts` | The only two model calls: listing facts, and reading a drawing            |

## Testing

No test reaches the network or a model provider. The two model calls run against
`MockLanguageModelV2`, so their schemas, their price conversion and the images they send
are covered without an API key. `tests/golden.test.ts` runs against snapshots captured
from live retailer pages, including the parts that do not work yet, so a change in
behaviour is visible.

`bun run typecheck:shared` uses `tsconfig.shared.json` to check shared code, offline
tests, and their dependencies without generated Convex bindings or a deployment. The
full frontend and backend still require `bun run typecheck` with generated bindings.

The drawing reader downloads images itself, checks their MIME type and size, and passes
bytes to the model. Unreadable images are skipped. If no image can be read, dimensions
remain unknown; a failed model call is caught per candidate rather than failing the search.

Live runs against four bedroom briefs — a lamp, a rug, a wardrobe, a print — are the
historical benchmark with a target of three per task. The 2026-09-19 regression run returned 10 sized candidates out of 12
and exposed two retrieval issues now covered by tests: one merchant could dominate after
dimension checks, and indexed Amazon URLs could be dead for the user.

Known gaps, recorded as tests rather than hidden:

- A page whose only printed dimensions are an unordered triple yields nothing from text.
- A storefront that publishes no size yields nothing until a drawing is read.

## Configuration

`EXA_API_KEY` is required. `OPENAI_API_KEY` is required for the two model calls.
Both model calls default to `gpt-5.6-luna`, the house default for small, well-scoped
jobs; `RUMI_EXTRACTION_MODEL` and `RUMI_VISION_MODEL` override it per deployment. All of these are
deployment environment variables, never `VITE_` variables.

## Current shared contract

1. `measurementSchema` includes
   `evidence: { kind: "structured" | "spec-text" | "image" | "mixed" | "none", detail: string | null }`.
2. `searchTaskSchema` includes `maxHeight`, `palette`, and required `miscellaneous`.
3. `searchTaskResultSchema` returns `candidates: RankedCandidate[]` in place of
   `products`, with `category` and `query`. A caller still reading
   `.products` must move to `.candidates[].product`.
4. `productSchema` includes `images: string[]`, the gallery, best first. `imageUrl` stays as
   its first entry so product cards do not change.

## Out of scope

- Price floors, target prices, shipping and tax.
- Mounting type and installation constraints, beyond `excludeTags`.
- 3D assets: `assetId` stays `null` here.
- Placement. The agent reports what fits, never where it goes.

## Open questions

- Wall art states width and height and almost never a depth, so under the current
  contract a print can never be placed. A depth-less measurement for wall-mounted
  categories — or a 2D contract for them — is the single change that would fix an entire
  category, and it belongs to the room and renderer owners.

- Should an aesthetic re-rank of the top five live here, or in the main agent, which
  already receives the `breakdown` values?
- Should a fallback to the open web be marked on the result so the interface can say the
  price tier was not honoured?
- Should a page that yielded no drawing be remembered, so a repeated search does not pay
  for the same silence twice?
