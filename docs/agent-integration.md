# Room workspace chat

The room workspace includes a collapsible design chat using the same cream, sage,
and serif styles as the capture editor. Sign in with Clerk, then start a chat with
text or an inspiration image. Conversations persist per account and support
history, rename, confirmed deletion, option cards, custom answers, and retrying a
failed reply. Selecting furniture opens the inspector; the chat panel collapses into a
top-right chat icon. Reopening it preserves the conversation, draft, and scroll
position.

## Room context

A conversation can begin before a scan exists. Its room is then explicitly null;
the agent can discuss style and budget without inventing dimensions. Creating a
chat with a room open copies that room's validated snapshot into the project.

Once attached, the conversation and editor subscribe to the same authoritative
room through `design.get`. Manual and agent edits use the same validated command
pipeline. Sending a message never overwrites the room with a browser snapshot.
Attaching a different room remains an explicit action. Original scans and camera
state stay local; the current selection and product models are cached for reload
and included in saved-room exports.

The editor supports captured polygon floors, wall decor, rugs, and products placed
on supporting furniture. Placement checks cover actual floor polygons, walls,
object overlap and conservative doorway clearances. Unknown dimensions and absent
floor measurements cannot establish fit. Electrical, installation, ergonomic and
delivery checks remain outside this milestone.

`editDesign` accepts atomic add, move, replace, remove and lock commands. Each write
checks the current revision, canonical catalog dimensions and prices, product and
placement locks, and the final budget. A requested savings target is enforced with
`maxTotalCents`. The selected object's ID is attached to the chat turn, including
the first message. Canceled or expired turns cannot apply late edits. Undo restores
objects with a new revision and is bounded to ten changes and 250 KB per room.

Models are prepared asynchronously after products are placed. Dimensioned previews
remain usable while jobs run or fail. Ready approximate models replace previews
without moving the furniture. Retry is available in the product list; attempt IDs
prevent late jobs from overwriting newer results. Synthetic rooms seed only the
trusted, visibly labeled sample catalog and hand-authored approximate models.

## Demo checks

1. Open the sample room, choose Products, and place all four products. The selection
   subtotal should be $396, leaving $104 of the sample $500 budget.
2. Select the lamp, keep the product, and save. Removal and replacement are disabled;
   moving stays available until its placement is also locked.
3. Enter a lamp position of X=1, Y=0, Z=4.2. Saving shows a doorway conflict without
   changing the stored room. Apply the suggested clear placement or cancel.
4. Use Floor plan and the Move/Rotate handles or arrow controls. Undo, then reload
   to check persistence. Enter Walk inside, click an object, and open its chat.
5. On the synced personal deployment, find real products, place them, and wait for
   their approximate models. Ask "Keep this lamp, make the room warmer, and save
   $80." Check that the lamp is kept and the selection subtotal drops by at least
   $80. This flow needs the configured live search and model providers.

## API and ownership

- Public project, message, and upload-authorization functions require Clerk
  authentication. Ownership uses `identity.tokenIdentifier`, matching captures.
- `projects.create` takes a title, optional validated room, and optional first
  message. Creating a conversation and its first turn is transactional.
- Project and message lists use Convex pagination. The agent reads at most 100
  recent messages and supplies the last ten completed messages to the model.
- Only one reply runs per project at a time. Errors and timeouts release the
  pending turn. Retrying creates a new reply record, so an old timeout cannot
  cancel the new attempt.
- Images use an authenticated, expiring, single-use upload capability bound to a
  project. The HTTP upload route checks file size, MIME type, and image signature,
  stores the bytes itself, and consumes the capability transactionally. It never
  accepts an arbitrary client-supplied storage ID. JPEG, PNG, WebP, and GIF files up
  to 10 MB are accepted.
- Image analysis is handed to the main agent as visual inspiration, not verified
  geometry. Agent and image-analysis functions remain internal.
- Deleting a project removes access immediately, then cleans up messages and
  stored images in batches. Unused upload capabilities expire after ten minutes.

## Development configuration

Follow `convex-workflow.md` and confirm personal deployment ownership before
syncing with `bunx convex dev --once`. The frontend needs `VITE_CONVEX_URL` and
`VITE_CLERK_PUBLISHABLE_KEY`. Clerk's Convex JWT template and the backend
`CLERK_JWT_ISSUER_DOMAIN` must be configured as for capture pairing.

Set these variables on the personal Convex deployment:

- `OPENAI_API_KEY`: required for chat and image analysis.
- `EXA_API_KEY`: required only for live product search. Without it, chat explains
  that product search is unavailable and can continue refining the brief.
- `RUMI_AGENT_MODEL`, `RUMI_EXTRACTION_MODEL`, `RUMI_IMAGE_MODEL`: optional model
  overrides. The existing defaults are `gpt-4o` and `gpt-4o-mini`.
- `RUMI_PLANNER_MODEL`, `RUMI_PLANNER_REASONING`: optional overrides for the
  space planner's zone proposal. Defaults are `gpt-6-astra` (falling back to
  `RUMI_AGENT_MODEL`) and `low` reasoning effort.
- `RUMI_ASSET_MODEL`: optional model override for approximate product models.
- `CHAT_ALLOWED_ORIGINS`: comma-separated exact frontend origins allowed to
  upload images, including scheme and port. Add the intended app origin before
  serving the frontend from a new address.

Provider keys may also be kept in the checkout's ignored `.env.local` for local
scripts. That does not configure the cloud deployment. Never prefix secrets with
`VITE_` or commit them.

## Schema compatibility

`projects.roomId` is now optional to represent chats without scans. Project brief
and active-reply fields are optional for compatibility with existing records.
`imageUploads` is additive. Room history, selected-object message context, object
mount/support/product-lock fields and asset attempt/error timestamps are optional.
Existing records need no destructive migration. Deploy the backend before using
the connected editor. No ownership transfer occurs.
Old device-owned development projects remain inaccessible through the Clerk API;
any transfer requires a separately verified ownership mapping.

## Verification

Run `bun run typecheck`, `bun run lint`, and `bun test`. Tests cover authentication,
room attachment and revision conflicts, custom answers, retry/timeout handling,
upload authorization and replay rejection, image validation, and retained capture
and proposal behavior. Provider actions are excluded from deterministic tests.

Live verification on the personal development deployment exercised chat-driven
movement of a kept lamp and a real product search followed by an atomic rug
replacement. The selection dropped from $396 to $292 while preserving the lamp.
The product-model job failed on its first attempt; retry produced a ready model
from the merchant's photos, which appeared in the room without changing placement.
Browser checks also covered sample placement, budget rejection, doorway and
collision rejection, suggested placement, undo, reload, first-person selection and
chat context, and the mobile product list and inspector. Earlier live checks
covered option cards, custom answers, and uploaded-image analysis. Provider output
can vary; these checks do not replace the deterministic contract and state tests.

The art-planning regression also uses a copy of a captured bedroom whose vanity
mirror is classified as art. Explicitly requested paintings can still receive a
wall zone; painting, poster, and print categories satisfy an art request. Live
checks confirmed that canceling the painting clears the saved requirement without
replanning, and a subsequent plants request produces a plan without art.

Natural-language product placement can use `add` with `nearObjectId`, or `arrange`
for a product already in the room, without coordinates. Small plants and tabletop
decor choose a clear supporting surface near that furniture. Missing supports
produce a placement error instead of dropping tabletop decor on the floor.
Placement keeps existing locks and never adds a lock automatically. The inspector's
Find a good spot action uses the same validation. Coordinate fields remain optional.

Product generation uses a strict geometry schema and one correction attempt for
invalid output. Failed jobs show a labeled size preview in the viewport. The live
plant regression generated four recognizable pots with foliage, placed the set on
the bedside table, and verified the inspector action and persistence in the browser.
