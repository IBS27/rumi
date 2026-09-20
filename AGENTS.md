# Working in rumi

React + Vite + TypeScript + Tailwind, with Convex and Clerk. The frontend is a room capture/import and editing workspace with browser-local persistence. The authenticated design chat is integrated with the room workspace; see `docs/agent-integration.md`. Payments are paused.

## Where things live

- `src/App.tsx`: frontend entry; `src/features/`: room setup, room editor, room import, and team feature folders.
- `src/ui/`: the shared component kit and its rules (`src/ui/README.md`). Theme tokens live in `src/styles.css`. Reference design: `docs/design-new.html`, Plaster tab.
- `shared/contracts/`: Zod schemas and inferred types shared by both teams.
- `shared/fixtures/`: synthetic room/product data and deterministic search.
- `shared/geometry/` and `shared/budget/`: placement checks and price calculations.
- `convex/schema.ts`: backend storage schema; personal dev deployments use project `rumi` in the dedicated `rumi` team, CLI slug `rumi-4592b`.
- `convex/agent.ts` + `convex/search.ts`: internal agent functions — the main design agent's tool loop and the search agent. They require `EXA_API_KEY` and `OPENAI_API_KEY` in the deployment's environment, plus optional `RUMI_AGENT_MODEL`, `RUMI_EXTRACTION_MODEL`, `RUMI_VISION_MODEL`, `RUMI_PLANNER_MODEL` and `RUMI_PLANNER_REASONING` overrides (the search agent's two model calls default to `gpt-5.6-luna`; the planner defaults to `gpt-5.6-sol` at low reasoning).
- `shared/search/`: the search agent's pure pipeline — page reading, merchant data, dimension resolution, colour, ranking. Testable without a deployment; see [docs/search-agent.md](docs/search-agent.md).
- `convex-workflow.md`: teammate setup, deployment ownership, syncing changes, and schema migrations.
- `docs/spec.md`: product scope; `docs/contracts.md`: units, coordinates, and team handoff.
- `tests/`: contract and validation tests.

## Making changes

- Read the relevant contract before changing a feature. Update producers, consumers, fixtures, and tests together when changing a shared shape.
- Use strict TypeScript; avoid `any`. Validate external data with the shared schemas.
- Build UI from `src/ui` components and theme tokens only. No ad-hoc buttons, inputs, panels, or hex colours in feature code. The room view is the base layer of a workspace screen; other content floats over it in `FloatingPanel`s. Read `src/ui/README.md` first.
- Geometry uses meters and Y-up coordinates; money uses integer cents. Keep unknown dimensions explicit.
- Keep sample data labeled. Do not present fixture behavior as a live integration.
- Read [convex-workflow.md](convex-workflow.md) before configuring Convex or changing backend code. Check deployment ownership before running `bunx convex dev`; it pushes backend changes. Keep secrets out of Git and `VITE_` variables.
- Use Bun. Run `bun run typecheck`, `bun run lint`, and `bun test`. The full typecheck and the `chat`, `pairing` and `agent-integration` tests need `convex/_generated`. `bun run typecheck:shared` uses `tsconfig.shared.json` to check shared code, offline tests, and their dependencies without generated bindings or a deployment; it does not replace the full frontend and backend typecheck. Keep tests focused on behavior and use `bun:test`; check UI changes in the browser.
- Do not run production builds or deploy unless asked.
