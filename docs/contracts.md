# Search ↔ room handoff

## Conventions

`shared/contracts/index.ts` is the authority. All runtime inputs pass through its Zod schemas; TypeScript types are inferred from those schemas.

- Meters; right-handed, Y-up coordinates. Rectangular fixtures use a northwest floor origin, +X east and +Z south. Captures preserve the scan's axis orientation and translate the minimum X/Z bounds and lowest floor elevation to zero. Object position is its local base center, not its geometric center; for tilted objects this point includes the full object rotation.
- Width is X, height is Y, depth is Z. Rotation is radians. The rectangular placement validator supports yaw around Y and rejects pitch/roll. Captured furniture retains all three rotation axes for rendering.
- Polygon captures retain surface polygons and column-major local-to-room matrices. Their room dimensions are overall bounds; floors may be absent. Original scan JSON is retained independently of user corrections. Polygon furniture-fit validation is not available yet.
- Rectangular room dimensions are authoritative; openings reference a wall and an offset along +X for north/south or +Z for east/west.
- USD prices use integer cents. Product price is per instance; owned furniture costs zero in the new selection.
- Product IDs identify one purchasable variant in the normalized catalog. Object IDs identify instances, allowing future multiple quantities. Asset IDs are independent.
- Unknown product dimensions are `null` with source `unknown`. Never infer a physical fit from an unscaled image. Synthetic data is explicitly marked.
- GLB assets use meters after applying their normalization scale/rotation. A `ready` asset requires either a URL or a validated parametric scene. Parametric scenes use normalized part coordinates and carry their physical dimensions in meters; placeholders need no external asset. Geometry accuracy and availability are independent.

## Boundaries

| Input/output                      | Owner          | Consumer                         |
| --------------------------------- | -------------- | -------------------------------- |
| `RoomSnapshot`                    | Capture/editor | Search, renderer, validation     |
| `DesignBrief`                     | Conversation   | Search and budget checks         |
| `SearchRequest` → `SearchResult`  | Search adapter | Assistant/product panel          |
| `SearchTask` → `SearchTaskResult` | Search agent   | Main agent `searchProducts` tool |
| `ProductCandidate`                | Search/catalog | Product cards, assets, budget    |
| `DesignProposal`                  | Agent/planner  | Validated editor commands        |
| `AssetRecord`                     | Asset pipeline | Renderer                         |

The first proposal operation is additions only. Define explicit move/remove operations when the agent supports them; never silently replace a complete room snapshot. `baseRevision` must match the current room revision, and accepted edits increment it.

The fixture adapter is synchronous. A live search implementation may return a promise of the same validated result and report progress separately. The renderer must not depend on a model provider or search API response format.

The live path is two levels. `convex/agent.ts` plans the room and calls the internal `convex/search.ts` action `searchProducts` with a `SearchTask`. Hard constraints are `maxPriceCents`, `maxFootprint`, `maxHeight`, and `excludeTags`; `maxPriceCents: 0` means no price ceiling. `styleTerms`, `palette`, and required `miscellaneous` are soft preferences that influence retrieval and ranking. Use an empty `miscellaneous` array when there are no additional requested specifications.

The search agent reads product pages, normalizes them into `ProductCandidate` records, and checks availability and hard constraints in code. The action returns a `SearchTaskResult` with at most one `RankedCandidate`, including its score breakdown, plus `failures` explaining extraction and filtering problems. The internal `searchCategories` action supports up to eight tasks with the same per-task limit, but is not currently exposed in the main agent's tool set.

Extracted dimensions are always `estimated`, never `confirmed`, and `measurement.evidence` records their source: structured merchant data, a printed specification, a dimension drawing, or nothing. A product carries its gallery in `images`, with `imageUrl` as the first entry. Agent and search functions are internal. Public project and message functions require authenticated ownership; the room workspace chat calls them. See [the search agent](search-agent.md) for the pipeline and [agent integration](agent-integration.md) for API and migration details.

## Applying a result

1. Normalize product details into `ProductCandidate`.
2. Resolve dimensions and create a proposed room object with a unique ID.
3. Validate proposal revision, product availability, exact variant dimensions, room bounds, collisions, doorway clearance, and budget.
4. Apply atomically. Keep existing/locked objects unchanged.
5. Render a placeholder immediately. Asset generation/loading is a separate job.

The initial image-to-3D path creates an approximate parametric scene rather than an
arbitrary triangle mesh. Astra reviews up to eight gallery photos, selects a dimension
drawing plus distinct viewing angles when available, and sends only those selected four
images into reconstruction. It describes visible parts using bounded boxes, cylinders,
and spheres. The application owns the product's
physical dimensions and scales the scene to them; the model cannot change the room
footprint. See [image-to-3D assets](asset-generation.md).

`shared/geometry` supplies deterministic validation and a simple placement scan. It is a starter, not an interior-design optimizer. Rug overlaps are allowed; a door uses a conservative square clearance. Electrical, installation, delivery-fit, and ergonomic checks remain future work.

## Fixtures

`shared/fixtures/index.ts` exports a 4.8 × 4.2 × 2.7 m bedroom, two owned pieces, a $500 brief, four synthetic products, placeholder asset records, a valid proposal, and oversized/unknown/unaffordable/unavailable product cases. Merchant URLs use `example.com` and are not real listings.

`shared/fixtures/search.ts` provides a deterministic search adapter for independent team development and tests. The room workspace imports captured rooms and stores edits locally. `shared/fixtures/roomplan.ts` supplies an independently authored, explicitly synthetic L-shaped room. When adding cloud room persistence, use authenticated Convex mutations and reject stale revisions on the server; keep transient camera/selection state local.

## Detailed capture package

The native-to-web `rumi.capture` v1 ZIP carries the unchanged final RoomPlan JSON, ARKit mesh buffers, JPEGs, camera calibration, depth, and confidence. `shared/capture/package.ts` validates it. [Surface capture](surface-capture.md) defines units, binary layouts, coordinate transforms, limits, local persistence, and the boundary between measured surfaces and editable furniture. This does not change `RoomSnapshot`. The [pairing contract](room-capture-pairing.md#complete-scan-transfer) adds an optional direct-storage ZIP transfer alongside the original JSON endpoint.
