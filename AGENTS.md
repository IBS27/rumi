# Working in rumi

React + Vite + TypeScript + Tailwind, with Convex as the planned backend. The frontend currently contains static placeholders. Live search, room capture, auth, and backend functions are not implemented. Payments are paused.

## Where things live

- `src/App.tsx`: frontend entry; `src/features/`: sidebar, room editor, and team feature folders.
- `shared/contracts/`: Zod schemas and inferred types shared by both teams.
- `shared/fixtures/`: synthetic room/product data and deterministic search.
- `shared/geometry/` and `shared/budget/`: placement checks and price calculations.
- `convex/schema.ts`: backend storage schema; personal dev deployments use project `rumi` in the dedicated `rumi` team, CLI slug `rumi-4592b`.
- `convex/agent.ts` + `convex/search.ts`: internal agent functions — the main design agent's tool loop and the web-search subagent. They require `EXA_API_KEY` and `OPENAI_API_KEY` in the deployment's environment, plus optional `RUMI_AGENT_MODEL`/`RUMI_EXTRACTION_MODEL` overrides.
- `shared/search/`: the subagent's pure pipeline — Exa client, query building, dedupe, and hard-constraint filtering. Testable without a deployment.
- `convex-workflow.md`: teammate setup, deployment ownership, syncing changes, and schema migrations.
- `docs/spec.md`: product scope; `docs/contracts.md`: units, coordinates, and team handoff.
- `tests/`: contract and validation tests.

## Making changes

- Read the relevant contract before changing a feature. Update producers, consumers, fixtures, and tests together when changing a shared shape.
- Use strict TypeScript; avoid `any`. Validate external data with the shared schemas.
- Geometry uses meters and Y-up coordinates; money uses integer cents. Keep unknown dimensions explicit.
- Keep sample data labeled. Do not present fixture behavior as a live integration.
- Read [convex-workflow.md](convex-workflow.md) before configuring Convex or changing backend code. Check deployment ownership before running `bunx convex dev`; it pushes backend changes. Keep secrets out of Git and `VITE_` variables.
- Use Bun. Run `bun run typecheck`, `bun run lint`, and `bun test`. Keep tests focused on behavior and use `bun:test`; check UI changes in the browser.
- Do not run production builds or deploy unless asked.
