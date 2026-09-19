# rumi

React, Vite, TypeScript, Tailwind, React Three Fiber/Drei, Zustand, Zod, and a Convex schema. The frontend is a static two-column placeholder: sidebar section descriptions beside an empty 3D room area. There is no branding or functional interface.

## Run locally

```sh
bun install
bun run dev
```

No credentials are required. Start the frontend in `src/App.tsx`; Tailwind is available through `src/styles.css`.

```sh
bun run typecheck
bun run lint
bun test
```

Tests use Bun's built-in runner, with no separate test configuration. `tests/contracts.test.ts` covers shared contracts, product search fixtures, budget enforcement, and placement validation. Run `bun test --watch` while editing. Check frontend changes in the browser; there is no browser test framework installed. No production build is needed.

## Team ownership

Feature directories reserve space for future frontend work. `src/features/workspace/Sidebar.tsx` displays descriptions of the planned sidebar sections. `src/features/room-editor/RoomPlaceholder.tsx` describes the future 3D canvas. `src/App.tsx` places them side by side; neither has controls or live data.

| Owner           | Files                                                                                  | Responsibility                                     |
| --------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Search 1        | `src/features/search/`, future `convex/search/`                                        | Discovery, product normalization, catalog adapters |
| Search 2        | `src/features/assistant/`, future `convex/agent/`                                      | Conversation, preferences, recommendations         |
| 3D 1            | `src/features/room-setup/`, `shared/geometry/`                                         | Capture, measurements, geometry, fit checks        |
| 3D 2            | `src/features/room-editor/`, future `convex/assets/`                                   | Rendering, controls, assets, product placement     |
| Joint ownership | `shared/contracts/`, `shared/fixtures/`, `src/features/workspace/`, `convex/schema.ts` | Team handoff and integration                       |

Agree on contract changes before merging them. Both pairs can use the shared fixtures without a frontend or live services.

## Convex setup

The schema and dependency are ready. `src/main.tsx` optionally provides a Convex client when `VITE_CONVEX_URL` is set. The [shared Convex project](https://dashboard.convex.dev/t/rumi-4592b/rumi) belongs to the dedicated `rumi` team, CLI slug `rumi-4592b`. A personal dev deployment exists; no live queries, mutations, or authentication are implemented.

Assign deployment ownership before running a watcher. Each developer should use their own development deployment within the shared project; deploy merged code to the shared production backend.

Follow [convex-workflow.md](convex-workflow.md) for team invitations, personal deployment setup, and syncing changes after a pull. The CLI writes your connection settings to Git-ignored `.env.local`. Generated files are ignored; no hand-written generated stubs are included.

Before adding public functions, configure authentication and enforce ownership. Parse inputs with the shared Zod schemas: converted Convex storage validators do not enforce Zod refinements. Use the Convex Agent component for live conversation persistence and Workflow for durable asset jobs.

## Shared foundation

- Validated room, product, asset, brief, and proposal contracts.
- A synthetic bedroom/catalog and edge-case fixtures.
- Deterministic fixture search, budget calculations, and basic spatial checks.
- Rectangular rooms and yaw-based placements; extend jointly for other geometry.

No payment, checkout, or order code is present. See [the handoff contract](docs/contracts.md) and [the product spec](docs/spec.md) for planned behavior.

## Before the team starts

Both pairs can begin locally with the shared contracts and fixtures. For live integration:

- Share the scaffold through Git and give all teammates repository access.
- Invite teammates to the dedicated `rumi` team and configure each developer's development deployment in the existing project.
- Assign ownership of backend functions and schema changes; deploy merged code to the shared production backend.
- Choose the live model/search and 3D asset providers, then configure their credentials on the backend. Never put provider secrets in `VITE_` variables.
- Add authentication and authenticated room persistence before storing real user data.

The live providers, authentication, backend functions, and hosting pipeline are not configured by this scaffold. Payments remain paused.
