# Convex workflow

## Shared project, personal deployments

We use the `rumi` project in the dedicated `rumi` Convex team, whose URL and CLI slug is `rumi-4592b`:
[project dashboard](https://dashboard.convex.dev/t/rumi-4592b/rumi).

Invite teammates through this team's **Team Settings → Team Members**, using the **Developer** role for normal development. Team membership grants access to projects within that team, so keep unrelated projects in other teams. Teammates do not need access to Srinivas's personal team.

Each teammate uses their own Convex account and personal development deployment within this project. Git shares the schema and functions; each deployment has its own running code and database. Do not share a dev deployment between people or run watchers from different branches against the same deployment: they can overwrite each other's backend code.

The project and Srinivas's `dev/srinivas` deployment have been created. Other teammates must configure their own deployments. The frontend still uses placeholders, and authentication and backend functions are not implemented. Creating the project did not push the schema. No production deployment has been set up for this workflow; a custom domain is not required for one.

## First-time setup

1. Ask the project owner to invite your Convex account to the `rumi` team at `rumi-4592b`, then accept the invitation.
2. Clone the repository and install dependencies:

   ```sh
   bun install
   ```

3. Configure the existing project and a personal cloud dev deployment:

   ```sh
   bunx convex dev --configure existing --team rumi-4592b --project rumi --dev-deployment cloud
   ```

   Sign in with your own account if prompted. Verify the team, project, and personal deployment before syncing. Do not create another `rumi` project or select someone else's deployment. This command pushes the checked-out backend code and stays running to watch for changes.

4. In another terminal, start the frontend:

   ```sh
   bun run dev
   ```

The CLI writes `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` to `.env.local`. This file is ignored by Git and belongs to your checkout. Do not copy another teammate's file. Restart Vite after changing its environment variables.

Keep provider secrets in the backend deployment's environment variables. Never put secrets in `VITE_` variables, which are exposed to the browser. Each deployment needs its own service configuration.

### Existing checkouts after the team transfer

The existing project and its deployments moved to the dedicated team; the deployment URLs are unchanged. If your checkout was configured before the move, select your existing deployment under the new team to refresh `.env.local`. For Srinivas's checkout:

```sh
bunx convex deployment select rumi-4592b:rumi:dev/srinivas
```

Other teammates must use their own deployment reference. Selecting a deployment updates the local connection settings without pushing backend code. New teammates should follow the first-time setup above.

## Daily development

Work on a feature branch and run these in separate terminals:

```sh
bunx convex dev
```

```sh
bun run dev
```

`convex dev` syncs schema and function changes to your selected dev deployment and regenerates the bindings in `convex/_generated/`. Generated bindings are ignored by Git; do not edit them manually. `bun run convex:codegen` regenerates bindings when needed, but is not a substitute for pushing backend changes.

Stop the Convex watcher before switching branches. Restart it after the switch so you deliberately sync the new branch to your deployment. For simultaneous work in multiple checkouts, use separate deployments.

## Getting changes merged by teammates

With a clean working tree, update your local `main` and sync its backend code:

```sh
git switch main
git pull --ff-only origin main
bun install
bunx convex dev
```

If you are continuing a feature branch, merge or rebase the updated `main` into that branch before restarting the watcher. If a watcher is already running when files change after a pull, it detects and syncs those changes automatically.

For a single sync that exits instead of watching:

```sh
bunx convex dev --once
```

Merging a PR alone does not update anyone's deployment. Each teammate must pull the code and sync it. Database records, uploaded files, and deployment environment variables are not copied by Git or `convex dev`.

## Data and schema changes

The repository has synthetic fixtures in `shared/fixtures/`, but no Convex seed command yet. Until one is added, do not assume another teammate's sample records exist in your database. Keep sample data labeled.

A schema push can fail if existing records do not satisfy new validators. Schema-changing PRs must include any required migration steps and their order. Prefer compatible changes followed by a migration before tightening validators. If dev data is disposable, the deployment owner can deliberately reset the affected data; never clear another person's deployment to fix a push.

Read `docs/contracts.md` before changing shared shapes. Update contracts, producers, consumers, fixtures, and tests together. Configure authentication and ownership checks before exposing user-data functions.

## Pull requests and shared releases

Before opening a PR, sync to your dev deployment, verify the changed behavior, and run:

```sh
bun run typecheck
bun run lint
bun test
```

Include new environment variable names, sample-data requirements, and migration instructions in the PR, without secret values.

Personal development uses `bunx convex dev`. `bunx convex deploy` targets production by default in a typical configured checkout; it is not the command for syncing your dev deployment. When a shared demo or production environment is needed, designate an owner or CI job to deploy reviewed `main`. Do not run production builds or production deployments unless explicitly requested.

See the official [team workflow](https://docs.convex.dev/production/overview) and [deployment configuration](https://docs.convex.dev/production/project-configuration) documentation.
