# Search ↔ room handoff

## Conventions

`shared/contracts/index.ts` is the authority. All runtime inputs pass through its Zod schemas; TypeScript types are inferred from those schemas.

`MAX_PLAN_ZONES` bounds shopping wants, zone proposals, persisted plans, and their
search tasks at twelve. The planner's default is four non-rug pieces; explicit
requests, room-defining furniture, and required supports are protected when optional
extras are trimmed. Free-floor measurements are advisory and add no slot identifiers
to the stored plan. Existing plans and briefs remain compatible.

`DesignBrief.excludedCategories` optionally lists furniture the user does not want
to shop for. Missing means no structured exclusions (older saved briefs remain
valid). Exclusions override room-purpose defaults and conflicting wants; they
never authorize deleting existing objects. The agent updates the complete list
when preferences change, and clears an exclusion when that item is requested again.

- Meters; right-handed, Y-up coordinates. Rectangular fixtures use a northwest floor origin, +X east and +Z south. Captures preserve the scan's axis orientation and translate the minimum X/Z bounds and lowest floor elevation to zero. Object position is its local base center, not its geometric center; for tilted objects this point includes the full object rotation.
- Width is X, height is Y, depth is Z. Rotation is radians. The rectangular placement validator supports yaw around Y and rejects pitch/roll. Captured furniture retains all three rotation axes for rendering.
- Polygon captures retain surface polygons and column-major local-to-room matrices. Their room dimensions are overall bounds; floors may be absent. Original scan JSON is retained independently of user corrections. Furniture placement is checked against measured floor polygons, including concavities and gaps, walls, object overlap and conservative doorway clearances. Missing floors remain explicitly unverified.
- Rectangular room dimensions are authoritative; openings reference a wall and an offset along +X for north/south or +Z for east/west.
- USD prices use integer cents. Product price is per instance; owned furniture costs zero in the new selection.
- Product IDs identify one purchasable variant in the normalized catalog. Object IDs identify instances, allowing multiple quantities of the same variant. Asset IDs are independent.
- Unknown product dimensions are `null` with source `unknown`. Never infer a physical fit from an unscaled image. Search must resolve all three dimensions before recommending a product; failed extraction triggers alternatives, never an unsized recommendation. Synthetic data is explicitly marked.
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

## Interactive design commands

`shared/design` is the common validator for editor and agent changes. Commands are
applied atomically to a cloned room, then checked against canonical product data,
the resulting full selection subtotal and the current room revision. The public
`design.edit` and internal `design.editByAgent` mutations use this same path.
`design.get` returns the authoritative room, brief, selected/recommended products,
asset states, reserved zones and undo availability together.

`RoomObject.locked` keeps the placement; `productLocked` keeps the selected product.
Only the user can unlock either. `mount` records floor, wall, surface or under;
`supportId` ties an accessory to its host instance and `zoneId` ties a placed product
to its planned spot. Supported accessories move with their host. Remove accessories
before deleting, replacing or resizing their host. Catalog item dimensions and
appearance cannot be changed by a scan correction; replace the variant instead.

`AssetRecord.attempt`, `updatedAt` and `error` describe background model work. Pending
and failed assets retain dimensioned previews. Approximate scenes stay within the
product's physical bounds. `shared/fixtures/design.ts` supplies clearly synthetic
scenes for the sample catalog. Saved-room files may include a `design` cache with
products, assets and brief; cloud project ownership is never restored from exports.

## Fixtures

`shared/fixtures/index.ts` exports a 4.8 × 4.2 × 2.7 m bedroom, two owned pieces, a $500 brief, four synthetic products, placeholder asset records, a valid proposal, and oversized/unknown/unaffordable/unavailable product cases. Merchant URLs use `example.com` and are not real listings.

`shared/fixtures/search.ts` provides a deterministic search adapter for independent team development and tests. The room workspace imports captures, stores standalone edits locally and uses authenticated cloud mutations once a conversation is attached. `shared/fixtures/roomplan.ts` supplies an independently authored, explicitly synthetic L-shaped room. Stale revisions are rejected on the server; transient camera/selection state remains local.

## Detailed capture package

The native-to-web `rumi.capture` v1 ZIP carries the unchanged final RoomPlan JSON, ARKit mesh buffers, JPEGs, camera calibration, depth, and confidence. `shared/capture/package.ts` validates it. [Surface capture](surface-capture.md) defines units, binary layouts, coordinate transforms, limits, local persistence, and the boundary between measured surfaces and editable furniture. This does not change `RoomSnapshot`. The [pairing contract](room-capture-pairing.md#complete-scan-transfer) adds an optional direct-storage ZIP transfer alongside the original JSON endpoint.

## Reconstructed room appearance

`shared/reconstruction/contracts.ts` defines versioned reconstruction evidence and
validated scenes. Evidence includes the original captured room, calibrated reduced
photos, and classified triangle samples in the same normalized meter coordinates.
Optional `surfaceObservations` attach depth-tested RGB samples to exact surface
IDs, front/back faces, photo indices and sample counts. They describe photographed
appearance under capture lighting, not calibrated material reflectance. Old
evidence without these observations remains valid.
A reconstructed scene preserves existing surface and furniture IDs and can add up to
48 photo-supported objects. Discovered objects carry calibrated placement estimates,
dimensions, photo references, evidence and confidence. They become owned, editable
room objects with estimated measurements and `detectionSource: "photo"`.
Attached details belong to their parent's assembly. Optional `renderBounds` expands
its visual box without changing scanned measurements; normalized part coordinates
remain X/Z [-0.5, 0.5], Y [0, 1] inside that visual box. Expansion must contain the
measured box and cannot extend more than two meters per side.
Surface colors may be null when unknown. Optional material detail carries a
procedural pattern, repeat dimensions in meters, and roughness. Optional surface
regions use local XY polygons and front/back/both faces; the renderer clips them
to measured boundaries and openings. Appearance revision 5 regenerates earlier
scenes without changing evidence version 1 or deleting old scenes.
Saved rooms optionally retain `reconstructionObjectIds`, including removed IDs,
so cached results do not overwrite edits or restore deleted discoveries. This
metadata also travels in exported ZIPs. Older saved rooms remain valid.
Both overview and first person consume the scene. See
[simulated room reconstruction](room-reconstruction-simulation.md).
