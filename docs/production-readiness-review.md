# Production readiness review

Reviewed on September 24, 2026, on `fedora`, at commit `e23ae46fb739bd620d1ac738cd88cc4414bdf744`. Checkout: `/home/srinivasib/.t3/worktrees/rumi/t3code-d35384a8`. The branch was named `t3code/production-architecture-review` at the end of the review.

**Recommendation: keep React, Vite, Three.js, Clerk, and Convex. Rework project persistence, AI execution, product identity, and file ownership before inviting public users.** The existing domain code is useful. Replacing the framework or database would leave the main correctness problems in place.

The intended first production scope should be a personal room-design workspace with persistent projects, capture/import, product discovery, editable layouts, and merchant links. Checkout, real-time collaborative editing, and guaranteed physical fit should remain separate milestones. This review assumes that scope and does not assume a particular traffic level or revenue model.

## Verification and limits of this review

Inspected frontend session/chat/editor integration, backend functions and storage schema, search and extraction, geometry/design contracts, reconstruction jobs, file handling, native capture code, tests, and release documentation. Checked current primary documentation for platform guarantees used in the recommendations.

- Installed dependencies with `bun install --frozen-lockfile`.
- A fresh checkout initially failed full typechecking and six test modules because `convex/_generated` is ignored and missing.
- Inspected the installed Convex CLI and generated local bindings through its offline codegen path, `bunx --no-install convex codegen --system-udfs --typecheck disable`. This internal CLI option is a review workaround, not a recommended production workflow.
- Full `bun run typecheck`, `bun run typecheck:shared`, and `bun run lint` passed afterward.
- `bun test` passed all 438 tests across 38 files.
- Ran isolated local probes for currency handling, catalog ID collisions, URL admission, expired-turn writes, and project cleanup. Results are below.
- No application source was changed. No production build, backend sync, deployment, paid model call, or live attack was performed.

This was a source and local-test review. I did not verify deployed infrastructure, production secrets/settings, GitHub branch protection, live provider quality, authenticated browser flows, or native compilation and physical LiDAR capture. Passing local tests does not establish those properties.

## What to preserve

The shared Zod contracts, meters/cents conventions, explicit unknown measurements, synthetic-data labels, and deterministic geometry/budget functions are the right foundations. `shared/design` gives pointer edits and agent edits a common validation path. `convex/design.ts` checks room revisions before committing and guards agent edits against the active message. Ownership comes from authenticated identity rather than caller-supplied account IDs.

Capture pairing already has expiring hashed capabilities, idempotent completion, bounded requests, and native redirect protection. ZIP validation checks paths, entry counts, and expanded sizes. Reconstruction already checkpoints batches and rejects late attempts. The renderer has error handling, resource disposal, a pixel-ratio cap, and demand rendering outside walkthrough mode. Extend these patterns; avoid replacing them with less tested abstractions.

## Findings to resolve before public access

### 1. An account cannot restore the complete workspace on another device

Evidence: [sessions.ts](../src/features/workspace/sessions.ts), [SessionShell.tsx](../src/features/workspace/SessionShell.tsx), [RoomWorkspace.tsx](../src/features/room-editor/RoomWorkspace.tsx), [scan storage](../src/features/room-editor/capture/storage.ts), [captures.ts](../convex/captures.ts).

The browser owns the session list, original room data, scan ZIPs, and some saved design state. Convex owns conversations and their room snapshots. `acceptDesign` requires an existing local workspace with the same room ID, so choosing a cloud conversation in a fresh browser does not itself create the room workspace. Cloud data exists, but the UI does not treat it as sufficient to open a project.

Phone uploads are temporary delivery artifacts. `captures.removeExpired` removes even successfully uploaded files after 24 hours. That is consistent with the current browser-local design, but it cannot support a promise that a signed-in user's original scan is saved online.

The local store compounds the problem. `readSessions` validates the entire sessions array together; one incompatible entry makes the whole store fall through to a fresh session. A subsequent save can overwrite the old store. Every save serializes all sessions into one localStorage value, including original room data and cached products/assets. Multiple tabs also hold independent in-memory copies of that value.

Change the ownership model:

1. Create a durable project as soon as a signed-in user saves/imports a room, independently of starting chat.
2. Open `/projects/:projectId` entirely from cloud records and owned artifacts. Chat becomes a child of the project.
3. Keep guest projects explicitly local. On sign-in, offer an idempotent import into the account. Do not silently merge another user's cache.
4. Store camera, selection, drag previews, and panel state locally. IndexedDB may cache server data; it must not be the only copy of a signed-in user's scan.
5. Give imports stable client IDs so retrying migration cannot create duplicate rooms.
6. Preserve original browser data until the server acknowledges a complete import. Quarantine invalid entries individually and offer export/recovery.

Release test: import on device A, finish saving, clear browser storage, open the project on device B, and recover the room, original capture, selections, chat, and reconstruction state.

### 2. Server-side fetching does not establish a safe network boundary

Evidence: [page.ts](../shared/search/page.ts), [search.ts](../convex/search.ts), [extract.ts](../convex/extract.ts), [assetGeneration.ts](../convex/assetGeneration.ts).

`isStorefrontUrl` checks HTTP/HTTPS and an asset-host pattern. Local probes confirmed it accepts loopback, link-local metadata addresses, and IPv6 loopback. Page fetches follow redirects automatically. Merchant image URLs are also fetched without a common destination policy. Search results and merchant HTML can therefore cause backend requests to destinations the application has not authorized.

This establishes an application-level SSRF gap. It is not proof that private network endpoints are reachable from the deployed Convex runtime. Deployment network restrictions may reduce exposure, but the application should enforce its own policy.

Resource limits are uneven too. `fetchPage` reads the complete response body. Image loaders check their five-megabyte limit after buffering the response. Several Exa, Shopify, image, and extraction calls have no explicit application deadline, and the agent's abort signal is not propagated into child search actions.

Create one controlled ingestion boundary. Require HTTPS; reject credentials and private/reserved destinations; validate DNS results and every redirect; restrict ports and redirect counts; cap bytes while streaming; validate media types and decoded pixel counts; and pass deadlines into every operation. A hostname regex alone cannot handle DNS rebinding. An isolated fetch/media worker with enforced outbound networking is a good service boundary here. Keep database/admin credentials out of that worker, and give it narrowly scoped job and object-store capabilities.

Prefer reviewed merchant adapters for the first release. Preserve open-web discovery behind the same network controls. [OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) describes the destination, DNS, and redirect checks this requires.

Release tests: private IPv4/IPv6, redirect-to-private, rebinding, oversized chunked bodies, image decompression limits, and slow responses, using controlled fixtures rather than real internal services.

### 3. Expiring a chat turn does not fence all of its writes

Evidence: [messages.ts](../convex/messages.ts), [projects.ts](../convex/projects.ts), [plans.ts](../convex/plans.ts), [agent.ts](../convex/agent.ts).

There are good active-message checks in progress updates and `design.editByAgent`. However, `projects.updateBrief`, `projects.setPhase`, `plans.propose`, and `messages.ask` do not require the originating turn to remain active. An expired or superseded action can still change preferences, advance a phase, or insert a question/plan.

A local Convex-test probe expired an assistant message, then successfully updated the project's brief and proposed a plan through these internal functions. The probe demonstrates missing write guards; it does not claim every ordinary timeout will hit this race.

The agent currently keeps tool-loop state in one action. The stream has a 110-second abort; the message watchdog runs at 180 seconds. Zone searches fan out through `Promise.all`, and the final set of zone recommendations is assigned after all searches settle. A failed parent can lose the association between completed work and its user-visible result. Retrying inserts a new assistant reply and starts orchestration again rather than resuming recorded steps.

Use durable runs and steps. Every state-changing tool should carry `runId`, `attempt`, `stepId`, and expected resource versions. Commit mutations must verify that the run still belongs to an active project and is neither canceled nor superseded. A new user instruction that invalidates a plan should invalidate the relevant run. Search results may finish into a reusable cache, but they must not modify a superseded project.

Persist each zone result as it finishes. Make command application idempotent with a stable command ID, independent of room revision. A revision rejects stale commands; it does not identify a successful command whose acknowledgment was lost.

Use Convex Workflow for orchestration and bounded work pools for provider calls. Scheduled actions themselves are not automatically retried. Durable orchestration still requires idempotent side effects and may repeat a provider request if the response was lost before recording it. [Scheduling guarantees](https://docs.convex.dev/scheduling/scheduled-functions), [Workflow](https://www.convex.dev/components/workflow), [Workpool](https://www.convex.dev/components/workpool).

Release test: interrupt after a search or edit commits, retry, and show the same result without duplicate objects or new writes from the expired run.

### 4. Authentication does not bound AI spending

Evidence: [projects.ts](../convex/projects.ts), [messages.ts](../convex/messages.ts), [assets.ts](../convex/assets.ts), [roomReconstruction.ts](../convex/roomReconstruction.ts), [pipeline.ts](../shared/search/pipeline.ts).

One active reply per project is not a per-account limit. A signed-in user can create multiple projects and run searches concurrently. Asset retries have no cumulative per-user spend allowance. There is no shared usage ledger or admission budget across chat, search, vision, and reconstruction.

Existing controls matter: capture creation has a rate limit; reconstruction permits two active jobs and 24 newly created jobs per day, with three attempts; search has extraction/vision limits. But these do not bound total monetary exposure across the product. Each zone search also has its own concurrency, so twelve zones multiply downstream work.

Introduce an entitlement and usage service before optional billing. Reserve an estimated maximum budget transactionally when admitting a run, record actual provider usage at every step, and reconcile unused reservations. Use integer micro-units for AI cost accounting, not floating dollars or whole cents. Account for retries and separate unknown provider outcomes from confirmed zero usage.

Enforce per-user daily allowances, active-run limits, upload/storage quotas, per-provider concurrency, and a global spending stop. Separate interactive chat/search capacity from slower reconstruction/model generation. Carry an overall call/token/time budget through nested actions. Provide a kill switch that disables costly work while preserving saved-project access.

Decide what a free user can do before launch. Charging users is optional; limiting what they can cost you is not.

### 5. Product identity and commerce facts are not reliable enough

Evidence: [index.ts](../shared/search/index.ts), [listing.ts](../shared/search/listing.ts), [candidate.ts](../shared/search/candidate.ts), [shopify.ts](../shared/search/shopify.ts), [products.ts](../convex/products.ts), [budget code](../shared/budget/index.ts).

Three concrete problems need correction:

- Currency is parsed from JSON-LD, omitted from `ListingFacts`, and replaced with literal USD in `buildCandidate`. A local CAD 100 fixture became USD 100. Hostname/country filtering does not establish currency on a `.com` store.
- Catalog IDs use a 32-bit FNV hash. A deterministic local probe found two distinct product URLs with the same ID after 51,322 generated URLs. `https://merchant.com/products/1xeldla-2zlbth` and `https://merchant.com/products/3iro7a-1uz5c6l`, both with variant `default`, produce `web-a52e3975`. Upserting the second replaces the first.
- Shopify parsing retains the merchant variant ID, but `factsFromShopify` uses the display title as identity and retains a product-level gallery/link. The dimension resolver reads general page content independently. Price, selected variant, dimensions, and photo can therefore refer to different options unless explicitly linked. Missing Shopify availability also defaults to available.

There is a larger data-model problem: searches overwrite global product documents. A saved room stores a product ID and copied dimensions, while its subtotal reads today's global catalog price. A later search can change the price or details of an already saved design without changing its room revision. Existing assets are retained even if extraction changes the product's dimensions or imagery.

Split stable merchant products/variants from observed offers and saved selections:

- Stable variant identity from merchant + merchant product ID + merchant variant ID. Where unavailable, use a canonical key with a collision-resistant digest and verify the full key on upsert.
- Append-only observations with original currency, price, stock, observed time, source URL, extraction version, and evidence. Unknown remains unknown.
- Variant-specific measurement evidence and image associations. Do not combine facts across sizes because they share a page.
- Saved selections pin the product/offer/measurement version used for that design. Display fresh prices separately and explicitly reconcile changes.
- Version assets by product geometry, source image digest, and generation version. Invalidated inputs produce a new asset.

For a USD-only release, reject unverified or non-USD offers. Add conversion only with explicit source currency and dated rate data. Surface last-checked time and retain the existing pre-tax/pre-shipping scope.

Release tests: ID collisions, renamed variants, CAD/EUR storefronts, missing stock, small/large variants sharing a page, and a catalog refresh while an old design is open.

### 6. Deletion and private-file access need a complete lifecycle

Evidence: [project cleanup](../convex/projects.ts), [schema](../convex/schema.ts), [images.ts](../convex/images.ts), [captures.ts](../convex/captures.ts), [roomReconstruction.ts](../convex/roomReconstruction.ts), [local scan storage](../src/features/room-editor/capture/storage.ts).

Project deletion removes its room and schedules batches of message/image deletion. It does not remove plans. A local probe confirmed a plan remains after its project is deleted and cleanup runs. Upload tickets expire separately; reconstruction records and their evidence/checkpoint blobs have no project relationship or user-facing deletion path. The local scan store exposes save/read but no deletion, so removing a local session does not reclaim its scan blob.

There is no account-deletion workflow or verified auth-deletion webhook in the inspected backend. The schema also leaves older proposals attached only through owner ID and embedded room identifiers.

Introduce explicit artifact ownership and references. Mark a project `deleting`, reject new jobs, cancel/fence active runs, delete children and blobs in bounded idempotent batches, then finalize. Link every private artifact to an account and project or a separately owned capture with an explicit retention policy. Do not delete globally shared catalog assets when one project is deleted. Add an orphan sweeper that only deletes proven unreferenced artifacts after a grace period.

Raw scans describe private homes. Current APIs return `storage.getUrl` URLs after checking ownership, but the URLs themselves can be used without further authentication. Use authenticated delivery for small private files or short-lived signed URLs from a private object store for large captures. Convex documents both this bearer-URL behavior and the 20 MB HTTP response limit, so proxying a 128 MB ZIP through a single Convex HTTP response is not the fix. [File access semantics](https://docs.convex.dev/file-storage/serve-files).

Make AI processing of capture photos clear before it starts, and allow scan-only use. Avoid raw images, prompts, and download tokens in routine telemetry. Account deletion should cancel active work, remove private derivatives, purge local data on that device, and record completion. Define what backups retain and for how long.

Release test: delete during upload, search, and reconstruction; verify no late result recreates private data and no unrelated user's artifact is removed.

## Target architecture

Keep one repository and a modular application backend. Separate a service only where it has a different security or execution requirement.

| Component | Responsibility | Recommended boundary |
| --- | --- | --- |
| React/Vite web app | Project navigation, editing, rendering, job progress | Cloud subscriptions plus local transient UI state |
| Swift capture app | Measurement, capture packaging, reliable upload | Versioned capture protocol and environment-specific configuration |
| Clerk | Authentication | Resolve verified identity to an application account |
| Convex application | Authorization, projects, room revisions, selections, job admission, subscriptions | All authoritative edits commit through typed mutations |
| Convex workflows/pools | Durable orchestration, retries, bounded concurrency | Persist run/step results; fence stale writes |
| Private object storage | Original captures, photos, derived scene files, intermediate evidence | Owned artifact records, signed access, retention rules |
| Isolated ingestion/media worker | Untrusted HTTP retrieval, decoding, large archive/media processing | Enforced network policy, limited credentials, signed job/result protocol |
| Shared domain modules | Units, geometry, budgets, command validation, contracts | Pure TypeScript with deterministic tests |

For private large captures, my default would be R2 with Convex storing ownership and metadata. It supplies a concrete path to expiring file access, and there is a maintained Convex integration. Keep storage behind a small artifact interface so choosing S3 later does not change room-editing code. Validate the exact upload and expiry behavior in staging before committing to an adapter. [Convex's storage guidance](https://docs.convex.dev/file-storage/serve-files), [R2 integration](https://www.convex.dev/components/cloudflare-r2).

The worker receives a leased job with an input artifact or approved fetch target. It writes output into that job's permitted prefix and reports its digest. The Convex completion mutation verifies the lease, run attempt, project state, artifact ownership, and output schema. A worker must never submit arbitrary room mutations or possess a production deployment/admin key.

Keep model orchestration in Convex initially. Move additional steps into workers only when they need larger memory, streaming, specialized libraries, GPU execution, or network isolation. A wholesale migration to Postgres/Temporal is justified by a demonstrated operational requirement, not by the presence of real users. If that requirement emerges, the domain modules and job contracts make migration possible without rewriting geometry or rendering.

## Recommended data model

| Records | Purpose and key invariants |
| --- | --- |
| `accounts` / `identities` | Stable application account, verified auth subject/issuer mapping, status, entitlements, deletion state |
| `projects` | Account ownership, title, current room/design reference, lifecycle state, timestamps |
| `rooms` / `roomGeometry` | Current revision and bounded editable state separated from immutable capture geometry |
| `captures` / `artifacts` | Source digest, protocol version, project/owner, blob key, byte size, media type, validation state, retention |
| `designCommands` | Unique client command ID, actor, base/result revisions, semantic command, timestamp |
| `briefs` / `plans` | Explicit revision, room revision, structured preferences, selected zones, run provenance |
| `conversations` / `messages` | Presentation/history associated with a project; no ownership of the room lifecycle |
| `runs` / `runSteps` | Intent, status, attempt, deadline, input versions, idempotency key, outputs, error class |
| `recommendations` | Durable project/plan/zone result pointing to a specific observed variant/offer |
| `catalogVariants` / `offerObservations` | Stable identity separated from time-sensitive, evidenced facts |
| `assetVersions` | Input and generation versions, status, source artifacts, bounded rendering metadata |
| `usageReservations` / `usageEvents` | Admission budget, provider usage, cost, retry attribution, reconciliation state |

Do not normalize every coordinate into an independent database row. A bounded array of room objects can remain the atomic design document. Separate bulky immutable geometry and history so an ordinary move does not resend them. Add explicit byte/count limits to public inputs: `room.objects` and several string/array fields currently have no application-level maximum even though imports and some other paths do.

Convex currently caps documents at 1 MiB. Existing undo history is already bounded to ten snapshots and 250 KB, and reconstructed scenes to 750 KB. Keep those safeguards while moving history and large scene payloads out of the frequently subscribed document. [Current limits](https://docs.convex.dev/production/state/limits).

## AI behavior and search architecture

The agent should interpret intent and propose typed actions; application state should determine which actions are legal. Today a long system prompt, `shouldForcePlanSpace`, and `choiceListToCard` compensate for model deviations. These are useful patches, but workflow progression should not depend on parsing the model's prose.

Define explicit events such as `briefUpdated`, `planningRequested`, `planConfirmed`, `zoneSearchCompleted`, and `designApplied`. Validate each transition in code. Move free-text interpretation into a typed result with provenance and then apply it through normal commands. Keep geometric rejection, locks, and budget enforcement independent of the model.

Replace the flattened last-ten-message transcript in `agent.runForProject` with structured role messages plus a durable, versioned brief. Room revision alone is insufficient for a plan: preferences and budget need their own revision, and accepted catalog facts need a version too. Treat merchant text, OCR, and image analysis as untrusted evidence. Structured output validates shape; it does not establish that a price or instruction is true.

Make search a reusable ingestion pipeline: retrieve approved candidates, cache bounded source material, extract variant-linked observations, validate them, then rank against the current room and brief. Cache extraction by canonical source + locale/currency + variant + source digest + extractor version. Cache request-specific ranking separately. Expire availability and price faster than dimensions. Single-flight identical in-progress jobs so several rooms do not pay to extract the same product at once.

Store recommendations independently of chat. `design.readDesign` currently reconstructs them from the newest 30 messages and 10 plans. That makes an unplaced recommendation disappear as conversation grows. `messages.list` also repeatedly looks up products and plans per message. Explicit recommendation records solve both lifecycle and query-shape problems.

Version model configuration and prompts centrally. Record provider/model IDs and usage for each step. Validate configured model access in staging rather than relying on a model name appearing in documentation or an example environment file. Keep provider failures typed: timeout, rate limit, authentication/configuration, invalid output, no valid candidate, and user cancellation require different recovery behavior.

## Frontend and rendering changes

The size of `RoomWorkspace.tsx` and `ChatPanel.tsx` matters because they combine independent state machines, not because a file crossed a line-count threshold. Extract by responsibility:

- `ProjectRoute` and a project controller load the authoritative workspace.
- A command controller handles previews, commit acknowledgments, conflicts, and undo.
- Capture import/export owns worker execution, progress, and artifacts.
- Chat owns conversation presentation and turn submission.
- Reconstruction owns job observation and applying validated results.
- The viewer consumes a scene and emits selection/preview events.

Use a single account/project library instead of separate local-session and cloud-chat histories. Expose save states such as saving, saved, offline, failed, and conflict. Preserve a rejected edit as a preview so a user can resolve it. Retain current revision checks. Do not add a CRDT until simultaneous collaborative editing is actually part of the product.

Lazy-load the 3D editor and expensive scene/effect modules. Keep the existing worker-based import, demand rendering, disposal, and viewer fallback. Add measured quality tiers that reduce shadows, effects, texture resolution, and geometry for weak devices. Provide a usable object list and 2D/measurement fallback when WebGL fails. Benchmark a realistic upper-bound scan on actual target hardware; no production bundle or GPU benchmark was performed in this review.

For reactive performance, split stable room/design subscriptions from streaming chat progress. `messages.updateProgress` can rewrite the growing text every 150 ms, while `design.get` reads the message range to recover recommendations. This couples ordinary streaming to expensive product/room reads and local cache writes. Use a dedicated run/progress subscription and batch text updates at an explicit rate. Keep full scene JSON behind artifact references.

Browser tests should cover keyboard-only controls, modal focus/escape behavior, room editing without a GPU, sign-out during a job, storage failures, two-tab conflicts, and a fresh account session. Existing DOM tests do not exercise the complete deployed browser/auth/WebGL system.

## Native capture and file ingestion

Keep Swift/RoomPlan. The native code already preserves source bytes, avoids credential-bearing redirects, and uses stable retry identities. Make development, staging, and production origins explicit release configuration. `CaptureClient.swift` currently admits exactly one hard-coded Convex site; changing only the web deployment will make a new QR origin fail validation. Preserve an allowlist rather than accepting arbitrary QR URLs.

Create a production bundle identifier and release configuration, a signed TestFlight release process, and a supported-device checklist. Version the protocol with explicit capabilities so an older installed phone app can still transfer to a newer backend. Where background/resumable transfers are required, persist only the necessary transfer metadata and protect resumable credentials; current transfer state is largely in memory.

Separate upload completion from validation and project adoption. Large ZIPs should upload directly to private storage, validate asynchronously, then become owned project artifacts. The browser should be able to close while validation continues. Keep current archive path/expansion bounds and add staged decode/memory budgets. For a genuinely large media pipeline, use streaming archive processing in the isolated worker rather than assuming the maximum ZIP fits comfortably alongside expanded buffers.

Run native XCTest on macOS CI and validate real capture, interrupted upload, app termination, QR expiry, and successful project restore on a physical LiDAR device. Source inspection on Fedora cannot substitute for these checks.

## Release engineering and operations

The checkout has no tracked CI workflow or hosting configuration, no production build script, and ignores the generated bindings required by its own full checks. Deployment settings may exist outside Git; they were not inspected. The written backend workflow still describes personal development deployments.

Add a reproducible release path:

1. Pin the Bun version and install with the frozen lockfile. Commit the supported generated Convex bindings, or supply a documented reproducible generation process. The default should follow Convex's recommendation to commit them. Do not make contributors deploy a backend merely to typecheck. [Generated-code guidance](https://docs.convex.dev/understanding/best-practices/other-recommendations#check-generated-code-into-version-control).
2. Require full typecheck, lint, unit/integration tests, and a small browser suite on every pull request. Add secret/dependency scanning and controlled updates.
3. Create separate staging and production environments, including auth instances, buckets, provider credentials, usage limits, and capture origins. Preview deployments must not share production data or credentials.
4. Add an explicit build script and SPA hosting/routing configuration. Fail production configuration checks when required services are absent; the current app silently falls back to the local preview when Clerk/Convex values are missing.
5. Release backend-compatible changes before frontend consumers. Use expand/backfill/contract migrations, checkpointed batches, validation counts, and a release version. Test old frontend and native clients against the new backend.
6. Deploy the frontend to Vercel and the backend through one controlled release pipeline. Treat the combined release as coordinated, not atomic. Restrict the production deploy key to production. [Convex/Vercel deployment guidance](https://docs.convex.dev/production/hosting/vercel).
7. Rehearse frontend rollback, provider disablement, failed-job recovery, and restore into an isolated environment. Keep code/config recovery separate from database recovery.

Add structured logs and traces around run/step IDs, account/project IDs, room/brief versions, provider request IDs, latency, usage, and classified errors. Scrub content and tokens. Integrate browser exception reporting and an operator view for stuck jobs, deletion progress, quota overrides, and safe retries. Operator actions need explicit authorization and an audit trail.

Measure saved-project restore success, edit commit latency, conflict rate, search success by merchant/category, useful-result latency, reconstruction completion, queue age, and cost per completed room. Establish performance targets from representative workloads. Any proposed targets before those measurements are launch criteria to validate, not claims about current capacity.

Back up tables and private blobs, and test restoring their references together. Convex backups do not include pending scheduled functions, environment variables, or deployed code. A recovery procedure must reconcile unfinished runs and re-enqueue only valid work. [Backup behavior](https://docs.convex.dev/database/backup-restore).

## Ordered implementation plan

| Sequence | Concrete change | Completion evidence |
| --- | --- | --- |
| 1 | Establish clean-checkout CI; commit generated bindings; add staged configuration validation | Fresh clone passes full checks without deployment credentials |
| 2 | Fix currency/variant handling and ID collisions; fence every mutating agent tool; repair project cleanup | Regression probes above become permanent tests and pass |
| 3 | Add controlled fetching, streaming size/deadline limits, quotas, usage reservations, and an emergency stop | Controlled abuse/provider-failure tests stay within configured limits |
| 4 | Introduce cloud projects and owned artifacts; separate chat from workspace lifecycle | Fresh-browser and second-device restoration work, including original captures |
| 5 | Migrate agent execution to durable runs/steps and bounded pools; persist per-zone recommendations | Interrupted runs resume; superseded runs cannot mutate projects; no duplicate edits |
| 6 | Migrate catalog observations and pinned design selections; version assets | Refreshing catalog data cannot silently rewrite saved designs |
| 7 | Split frontend controllers/subscriptions; add conflict recovery, route-based projects, device quality tiers | End-to-end save/edit/reload tests and measured target-device performance |
| 8 | Complete account deletion, private download policy, backup/restore, observability, native release checks | Deletion and restore drills pass; real phone-to-second-device flow succeeds |
| 9 | Run a bounded private beta on the production release path | Observed error rates, queue behavior, cost, and recovery meet explicit launch criteria |

Steps 2 and 3 are access gates. Cloud persistence and durable jobs are the main architectural work. Keep the beta invite-only and capped while collecting performance and cost evidence; user count alone is not a capacity model.

Migrate existing data with versioned readers. Add new optional fields/tables first, backfill server projects with checkpoints, and migrate browser-only originals only when that user's browser reconnects. Some original scans will be unavailable after local deletion and the 24-hour transfer retention period; mark those records honestly and request re-import rather than inventing a complete cloud backup. Keep old IDs through an alias table while updating product references, and audit any detected ID collision before removing the legacy lookup path.

For each change above, assign an owner and require behavior evidence. The first meaningful release milestone is a user completing a design, closing both devices, returning later, and recovering it without developer intervention, with provider failure and deletion handled predictably.
