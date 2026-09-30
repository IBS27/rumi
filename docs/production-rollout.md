# Production rollout

This change implements account-backed project routes, owned scan files, durable agent checkpoints, independent recommendations, immutable selected product facts, safe merchant fetching, deletion, and release checks. It keeps React, Convex, Clerk, and the native RoomPlan app. Spending controls remain deferred.

## Before deployment

No production build or backend deployment was performed during implementation. Configure and verify a dedicated staging deployment before releasing this branch. Do not point the new frontend at an older backend.

Required frontend settings:

- `VITE_APP_ENV=staging` or `production`.
- `VITE_CONVEX_URL` for that environment.
- `VITE_CLERK_PUBLISHABLE_KEY` from the matching Clerk instance. Production builds require a live key.
- `VITE_CAPTURE_PAIRING_ENABLED=true` only after the native transfer checks pass.

Required backend settings:

- `CLERK_JWT_ISSUER_DOMAIN` and an exact comma-separated `CHAT_ALLOWED_ORIGINS` list.
- `OPENAI_API_KEY`, `EXA_API_KEY`, and the model overrides documented in `.env.example`. Verify actual model access in staging.
- `CLERK_SECRET_KEY` for account deletion and `CLERK_WEBHOOK_SECRET` for signed Clerk notifications. Subscribe `/auth/webhook` to `user.deleted`. External identity deletion otherwise cannot trigger application cleanup. The webhook verifies signatures before accepting an event.

Use separate Clerk instances and provider credentials for staging and production. Never put backend secrets in `VITE_` variables. Vercel configuration supplies SPA routing, basic response security headers, the frozen Bun install, and the explicit frontend build command. `bun run build` validates deployment settings before invoking Vite.

Commit generated Convex bindings with backend changes. A clean checkout can run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run typecheck:shared`, `bun run lint`, and `bun test` without deployment credentials. CI also runs a browser smoke suite and native tests on macOS. The transitive `undici` override selects the patched 6.x line; the AI SDK uses its compatible HTTP fetch and Agent interfaces. These do not substitute for authenticated staging tests or a physical LiDAR capture.

## Data migration and compatibility

1. Export the deployment's database and storage files. Record the deployed commit and environment-variable names separately.
2. Sync the additive schema and backend to staging through its assigned owner.
3. Run the internal `migrations:allProjects` mutation with `{"cursor":null}`. It schedules bounded batches, pins existing selections using the catalog facts still available, and copies historical recommendations out of chat. Rerunning it is safe. Historical prices already overwritten before this migration cannot be recovered from the current catalog.
4. Release the matching frontend. Signed-in users receive `/projects/:projectId` routes and an account project library. Browser-only sessions upload when their owner returns. The importer preserves the local copy and records successful migration per session. Users whose browser storage or expired capture was already lost must re-import their original ZIP; the code does not invent an original file.
5. Validate old native protocol-v1 uploads with the new backend. Large accepted ZIPs are copied into bounded private chunks after validation. The iPhone upload protocol remains unchanged. The web capture download and image UI must be released together with this backend because public storage URLs are no longer returned.
6. Keep additive fields and old IDs while older clients remain in use. Do not delete old catalog rows or rewrite product IDs blindly. New IDs use SHA-256; upsert rejects a reused ID with a different canonical merchant/variant identity.

A project owns the current room and its source files. Conversation creation is no longer required to save an imported project. Source files use authenticated upload grants and five-minute download tickets. Completed room metadata and its matching scan publish in one transaction; incomplete or abandoned uploads expire without replacing the previous source pair. Each HTTP chunk is 4 MiB, below Convex's 20 MB HTTP request/response limit. Tickets remain bound to a live owner/project; deleting the project invalidates downloads immediately, with bounded physical cleanup afterward. Storage URLs used internally for model analysis are never returned in chat query results. [Convex HTTP limits](https://docs.convex.dev/functions/http-actions).

Large native uploads use Convex's direct upload endpoint, then ZIP validation in a Node action. Newly accepted ZIPs receive private download chunks. Accepted ZIPs from before this release receive private chunks on demand when their owner opens the capture. Captures are temporary transfers; durable account copies are saved by the project importer before transfer retention expires.

## Jobs, retries, and recovery

Each assistant reply owns `agentSteps` records. A model response and its tool-call inputs commit before execution. Tool results commit individually. A continuation action performs the next model step; a user retry copies checkpoints into a new reply so the previous reply stays fenced. Edit operations have transactional idempotency receipts. Plan/question cards also deduplicate their operation keys. Remote reads can repeat after an interruption; application edits cannot apply twice with the same key.

All project-mutating agent tools carry their originating reply ID. Expired, completed, superseded, or deleted turns cannot change the project. Per-zone search results persist as soon as each succeeds and can be reused when another zone fails. Failed zones leave the plan searchable. Room revision checks still reject concurrent conflicting edits.

After restoring a backup into an isolated deployment, verify storage references first. Backups do not restore pending scheduled functions, so every timer, cleanup batch and agent step that was pending at backup time is gone. Run the internal `operations:recover` mutation with `{"cursor":null}` once. It walks each table in bounded pages and re-arms its lifecycle, recording one `recover:<table>` operator event per page:

- Pending agent replies restart from their saved checkpoints, or from image analysis when that had not finished, with a fresh 180-second watchdog. Each recovery increments the reply's `runAttempt`. Every reply write carries the attempt it started with and is rejected in its own transaction once that attempt is stale. This covers checkpoints, tool results, brief, phase, plan, recommendation and design edits, questions, progress text, image-analysis results, completion, and watchdog timeouts. An older run can therefore neither change the project nor finish, time out or release the newer attempt. Replies that already finished release the project.
- Deleted projects keep a `projectDeletions` tombstone until their children are gone; recovery restarts that cleanup. Account deletions resume their data cleanup or Clerk identity deletion.
- Unpublished source uploads, download tickets, image upload grants and phone captures are given their original expiry again. Published source files are never touched.
- Pending model assets fail at their original five-minute deadline. Unfinished reconstructions fail after the normal reconstruction timeout, so owners can retry and keep completed batches.

Every rescheduled handler rechecks current state, so running recovery twice is safe. Recovery cannot cancel external calls already in flight from an older run, such as model, search, merchant-page or image-analysis requests. They still finish and are billed, and only their writes to the reply and project are discarded. Shared merchant caches and catalog observations from those calls may still be stored, but a saved design keeps its pinned product snapshot. Then inspect `operations:status` for remaining active replies, deletions and project cleanups. Never run recovery against a second deployment with production credentials accidentally copied into it. [Convex backup behavior](https://docs.convex.dev/database/backup-restore).

Public merchant HTML and JSON share a five-minute cache with leases that prevent simultaneous duplicate loads. The cache never includes room data or ranking results.

`agentSteps` stores model IDs, elapsed model time, and provider usage with checkpoint records. Server errors should be diagnosed using project/message/step IDs, without logging prompts, source images, bearer tickets, or provider keys. `operations:status` is an internal dashboard query, not a public administrative endpoint. Connect Convex logs and browser exceptions to the team's chosen monitoring destination during environment setup.

Daily storage cleanup removes tagged upload chunks left behind by interrupted HTTP actions. Project deletion records a tombstone, then cleanup removes plans, messages, image grants, images, recommendations, command receipts, steps, tickets, source files, and project-linked reconstruction artifacts. Account deletion blocks new authenticated writes immediately, deletes owned data in batches, then retries deletion of the Clerk identity. Minimal deletion tombstones remain so delayed jobs and duplicate webhook deliveries cannot recreate a deleted account's data. Backup retention must be handled separately from live-data deletion.

## Native release

Set `RUMI_CAPTURE_ORIGIN` in each Xcode build configuration or release invocation. It becomes `RumiCaptureOrigin` in the app's generated Info.plist. Release builds accept only that exact HTTPS origin and reject pairing when it is absent. Debug retains the existing personal development origin as a fallback. Set a team-owned bundle identifier and signing team before TestFlight; this repository cannot choose those account-owned values.

Transfer credentials and stable retry IDs are saved in a device-only Keychain item. Pending JSON bytes use protected app-support storage excluded from backup. A complete scan retains its saved file URL and storage receipt across app relaunch. An expired grant still requires pairing again. This is resumable foreground transfer, not a background URLSession implementation.

On a physical supported iPhone, check capture, claim-response loss, interrupted upload, app termination after storage upload, same-key retry, expired QR, sign-out, and restoration in a fresh desktop browser. Test native releases against staging before changing the allowlisted production origin.

## Required staging acceptance

- Import both JSON and a representative large ZIP. Close the browser, clear its local storage and IndexedDB, then restore the project on another authenticated browser. Verify geometry, selected products/prices, original export, scan photos, and reconstruction.
- Edit the same revision in two tabs. Exactly one edit commits, and the other reports a conflict without overwriting the latest room.
- Interrupt an agent after an edit and midway through zone search. Retry. Verify no duplicate placement/card, reuse of completed zones, and rejection of late writes from the previous reply.
- Exercise upload retries, rejected chunk sizes, expired tickets, invalid archive/image inputs, deletion during upload, and deletion during reconstruction.
- Delete a project and an account. Confirm records and blobs are removed, old tickets fail, Clerk identity deletion completes, and the signed deletion webhook is idempotent.
- Simulate provider errors and verify saved rooms remain editable. Check selected prices after a catalog refresh.
- Run the browser suite, keyboard/focus checks, no-WebGL fallback, and a realistic upper-bound scan on low-end target hardware. The adaptive renderer lowers pixel ratio and disables expensive effects after sustained slow frames; physical-device performance still needs measurement.
- Restore the backup into an isolated environment and complete the recovery procedure. Record restore success and elapsed time before opening access to users.

Do not treat unit tests as evidence that provider permissions, deployment routing, signing, storage throughput, or hardware capture have been validated. Those checks require the configured environments and devices above.


## Implementation verification

Local verification used the current Fedora checkout without deployment credentials. Both TypeScript checks, ESLint, and the Bun test suite passed. The dependency audit reported no known vulnerabilities. Browser interaction confirmed that opening the sample room, placing furniture, and reloading preserves the selection and budget. The collaborative browser disconnected before the remaining flows could be exercised; reopen this thread in the desktop application with its Browser panel to continue those checks.

The new CI browser suite and native tests have not run locally. Live Clerk/Convex flows, provider calls, cross-device restoration, backup recovery, and the iPhone transfer still require the staging acceptance above. No production build or deployment was run.
