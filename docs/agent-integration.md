# Room workspace chat

The room workspace includes a collapsible design chat using the same cream, sage,
and serif styles as the capture editor. Sign in with Clerk, then start a chat with
text or an inspiration image. Conversations persist per account and support
history, rename, confirmed deletion, option cards, custom answers, and retrying a
failed reply. Selecting furniture opens the inspector; the Design chat button
restores the conversation without discarding it.

## Room context

A conversation can begin before a scan exists. Its room is then explicitly null;
the agent can discuss style and budget without inventing dimensions. Creating a
chat with a room open copies that room's validated snapshot into the project.

The chat shows which room it uses. Edits to the same room are included with the
next message, option answer, or image upload. Attaching a different room is an
explicit action so opening an old conversation cannot silently replace its room.
The original scan and editor history remain local. A project's copy is separate
from the room currently displayed in the editor.

Captured polygon rooms can inform the conversation and product search, but
automatic furniture placement in polygon rooms remains unsupported. The agent
states that limitation and the server rejects unsupported placement. Rectangular
proposal application validates the current persisted budget and room revision.

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
- `CHAT_ALLOWED_ORIGINS`: comma-separated exact frontend origins allowed to
  upload images, including scheme and port. Add the intended app origin before
  serving the frontend from a new address.

Provider keys may also be kept in the checkout's ignored `.env.local` for local
scripts. That does not configure the cloud deployment. Never prefix secrets with
`VITE_` or commit them.

## Schema compatibility

`projects.roomId` is now optional to represent chats without scans. Project brief
and active-reply fields are optional for compatibility with existing records.
`imageUploads` is additive. No destructive migration or ownership transfer occurs.
Old device-owned development projects remain inaccessible through the Clerk API;
any transfer requires a separately verified ownership mapping.

## Verification

Run `bun run typecheck`, `bun run lint`, and `bun test`. Tests cover authentication,
room attachment and revision conflicts, custom answers, retry/timeout handling,
upload authorization and replay rejection, image validation, and retained capture
and proposal behavior. Provider actions are excluded from deterministic tests.

Live verification on the personal development deployment separately exercised a
real model reply with option cards, a custom answer, persisted style and budget,
and an uploaded image analyzed before the main agent's response. Product search
requires its own Exa key. Automated browser sign-up encountered Clerk's security
challenge; signed-out chat layout, collapse/restore, room editing, and mobile
layout were checked separately.
