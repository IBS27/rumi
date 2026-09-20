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
- GLB assets use meters after applying their normalization scale/rotation. `ready` requires a URL; placeholders need no external asset. Geometry accuracy and availability are independent.

## Boundaries

| Input/output                      | Owner           | Consumer                         |
| --------------------------------- | --------------- | -------------------------------- |
| `RoomSnapshot`                    | Capture/editor  | Search, renderer, validation     |
| `DesignBrief`                     | Conversation    | Search and budget checks         |
| `SearchRequest` → `SearchResult`  | Search adapter  | Assistant/product panel          |
| `SearchTask` → `SearchTaskResult` | Search subagent | Main agent `searchProducts` tool |
| `ProductCandidate`                | Search/catalog  | Product cards, assets, budget    |
| `DesignProposal`                  | Agent/planner   | Validated editor commands        |
| `AssetRecord`                     | Asset pipeline  | Renderer                         |

The first proposal operation is additions only. Define explicit move/remove operations when the agent supports them; never silently replace a complete room snapshot. `baseRevision` must match the current room revision, and accepted edits increment it.

The fixture adapter is synchronous. A live search implementation may return a promise of the same validated result and report progress separately. The renderer must not depend on a model provider or search API response format.

The live path is two levels. `convex/agent.ts` runs the main agent, which plans the room and calls `convex/search.ts` (`searchProducts`) with a `SearchTask` carrying hard constraints: `maxPriceCents`, `maxFootprint`, `styleTerms`, and `excludeTags`. The subagent searches the web, extracts pages into `ProductCandidate` records, filters against those constraints in code, and returns a `SearchTaskResult` whose `failures` tell the agent why candidates were dropped. Extracted dimensions are always `estimated`; unknowns stay `unknown`. Agent and search functions are internal. Public project and message functions require authenticated ownership; the room workspace chat calls them. See [agent integration](agent-integration.md) for API and migration details.

## Applying a result

1. Normalize product details into `ProductCandidate`.
2. Resolve dimensions and create a proposed room object with a unique ID.
3. Validate proposal revision, product availability, exact variant dimensions, room bounds, collisions, doorway clearance, and budget.
4. Apply atomically. Keep existing/locked objects unchanged.
5. Render a placeholder immediately. Asset generation/loading is a separate job.

`shared/geometry` supplies deterministic validation and a simple placement scan. It is a starter, not an interior-design optimizer. Rug overlaps are allowed; a door uses a conservative square clearance. Electrical, installation, delivery-fit, and ergonomic checks remain future work.

## Fixtures

`shared/fixtures/index.ts` exports a 4.8 × 4.2 × 2.7 m bedroom, two owned pieces, a $500 brief, four synthetic products, placeholder asset records, a valid proposal, and oversized/unknown/unaffordable/unavailable product cases. Merchant URLs use `example.com` and are not real listings.

`shared/fixtures/search.ts` provides a deterministic search adapter for independent team development and tests. The room workspace imports captured rooms and stores edits locally. `shared/fixtures/roomplan.ts` supplies an independently authored, explicitly synthetic L-shaped room. When adding cloud room persistence, use authenticated Convex mutations and reject stale revisions on the server; keep transient camera/selection state local.

## Detailed capture package

The native-to-web `rumi.capture` v1 ZIP carries the unchanged final RoomPlan JSON, ARKit mesh buffers, JPEGs, camera calibration, depth, and confidence. `shared/capture/package.ts` validates it. [Surface capture](surface-capture.md) defines units, binary layouts, coordinate transforms, limits, local persistence, and the boundary between measured surfaces and editable furniture. This does not change the `RoomSnapshot` or the JSON-only QR upload contract.
