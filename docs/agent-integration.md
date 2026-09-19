# Agent backend integration

PR #3 retains the room workspace from main, including its styles, Clerk providers,
capture pairing, inspector, import/export, and browser-local persistence. The entire
`src/` tree is unchanged from main at `0fc086d`.

The merge adds the design-agent loop, product search and extraction, project/chat
storage, option questions, and internal image analysis. It does not connect chat to
the visible room editor. The original chat UI remains in the PR's earlier commits
for a separate design and integration change.

## API boundaries

- Public project and message functions require Clerk authentication. Ownership is
  `identity.tokenIdentifier`, matching capture sessions. Clients cannot supply an
  owner ID.
- `projects.create` accepts a title and validated `RoomSnapshot`. It copies that
  snapshot into a project-owned room; it never invents room dimensions.
- Project and message lists accept Convex `paginationOpts`. Messages are returned
  newest first. The agent reads at most 100 recent messages and uses the last ten
  completed messages as its transcript.
- Image upload URL creation and saving are internal. Before exposing uploads in
  the future UI, implement an authenticated upload flow that binds the stored
  file to its owner; accepting an arbitrary storage ID is insufficient.
- Agent, search, catalog writes, image analysis, and room proposal application
  remain internal. Proposal application uses the persisted brief and checks the
  room revision, budget, and placement atomically.
- Captured polygon rooms are preserved, but furniture placement on polygons is
  still unsupported. The existing validator rejects it rather than treating the
  scan's bounding rectangle as usable floor area.
- Deleting a project immediately removes access and its room; scheduled cleanup
  deletes messages and images in batches. Late replies cannot recreate deleted
  messages or questions.

## Configuration and migration

Follow `convex-workflow.md` and confirm personal deployment ownership before
syncing. Merging does not deploy the backend.

Set `OPENAI_API_KEY` on the Convex deployment to run the agent and image analysis.
Set `EXA_API_KEY` for live product search. Optional model overrides are
`RUMI_AGENT_MODEL`, `RUMI_EXTRACTION_MODEL`, and `RUMI_IMAGE_MODEL`. No provider key
belongs in a `VITE_` variable.

The new tables are additive and retain main's `captures` table and room contract.
No data deletion or automatic ownership migration is required. If a development
deployment already ran the original PR, its device-owned projects remain
inaccessible through the authenticated API. Do not automatically adopt those
records based on a client-supplied device ID. Any transfer requires a separately
verified owner mapping; otherwise leave the old records untouched.

## Verification

Run `bun run typecheck`, `bun run lint`, and `bun test`. The integration tests
exercise authenticated ownership, cross-user denial, paginated history, deletion,
captured-room preservation, and atomic proposal application with `convex-test`.
Search tests use deterministic API responses, not live provider calls.

The integration preview was checked through sample-room loading, furniture edits,
reload persistence, floor-plan view, and dimension controls. Live provider calls,
Clerk sign-in, and phone pairing require a configured development deployment and
remain separate from this local verification.
