# Overnight task 01: release readiness evidence

Fedora worktree `/home/srinivasib/.t3/worktrees/rumi/t3code-090f1a24`, branch `t3code/production-readiness-verification`. Based on PR #37 head `dfafabd`. The branch is local only: nothing was pushed, merged, deployed, or published as a PR.

## Commits on top of PR #37

| Commit                      | Change                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `453aa39`                   | Mac commit `433514a` applied with `git am` from `/tmp/overnight-rumi-webgl-fix.patch`. Content is unchanged; the hash differs because the committer date changed. It falls back to the floor plan when WebGL2 is unavailable and scales the SVG keyboard outline. It fixes the no-WebGL browser test that fails PR #37 CI.                                                       |
| `6b2d629`                   | Merges PR #36 (`839fd31`) unchanged. Nothing is duplicated. It merged cleanly.                                                                                                                                                                                                                                                                                                   |
| `b411643`                   | Fixes a race that appears once #36 and #37 are combined. A cached reconstruction could finish before a cloud project's design subscription loaded. Discoveries were then written only to the uploaded source file and marked as applied, so they never reached the account room and were lost on reload. The scene now waits for the design connection and for any pending edit. |
| `2afdd9a`                   | Adds backup-restore recovery; see below.                                                                                                                                                                                                                                                                                                                                         |
| `89fd2bf`                   | Adds a browser test: download a room, then import it into a fresh browser context with empty storage.                                                                                                                                                                                                                                                                            |
| `a77c1b4`                   | Adds a unit test: save a room source and a three-chunk scan through the browser client and HTTP actions, restore them, then replace them.                                                                                                                                                                                                                                        |
| `2314e32`                   | Adds this evidence doc.                                                                                                                                                                                                                                                                                                                                                          |
| Next commit (attempt fence) | Coordinator review found that `runForProject` checked the attempt only at entry, so an action already past that check could still write to the reply after recovery. Every reply write, including completion and the watchdog, now checks the attempt in its own transaction. Adds a race test and a boundary test covering each writer.                                         |

### Recovery gaps fixed in `2afdd9a`

Convex backups omit scheduled functions. At `dfafabd`:

- `operations:recover` only rescheduled agent replies. Running it twice started two continuation chains for the same reply, which could double model spend.
- Deleting a project removed its row before cleanup ran. If a restore lost that cleanup, nothing recorded the project. Its messages, photos and private scan files stayed forever, and the daily storage sweep kept them because their `files` rows still existed.
- After a restore, capture retention (24 h), unpublished uploads, download tickets, image upload grants, pending assets, and running reconstructions lost their timers. Running reconstructions also kept counting against the two-active-job limit.

Changes:

- Replies carry a `runAttempt`, and recovery increments it. Every reply write checks the attempt inside its own transaction and rejects stale ones: checkpoints, tool results, brief, phase, plan, recommendation and design edits, questions, progress, image-analysis results, completion, and each attempt's watchdog. `runForProject` also exits early when its attempt is stale. The fence was added in the coordinator-review fix; an entry-only check let an action already past entry keep writing.
- `projectDeletions` tombstones remain until `projects.cleanup` finishes. `projects.remove` and account cleanup share `deleteProject`.
- `operations:recover` now works through table phases in bounded pages: replies, project deletions, account deletions, files, tickets, image uploads, captures, assets, and reconstructions. Published files are never touched. Every scheduled handler rechecks state, so rerunning is safe. `operations:status` lists pending project cleanups.
- `docs/production-rollout.md` has the updated runbook.

Schema changes are additive: an optional `messages.runAttempt` field and a new `projectDeletions` table. Projects deleted before this release have no tombstone.

## Checks with the attempt fence

| Check                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                  | pass                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun audit --audit-level high`                   | pass, no vulnerabilities                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run typecheck`                              | pass                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun run typecheck:shared`                       | pass                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun run lint`                                   | pass                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun test`                                       | 474 pass, 0 fail, 44 files. The baseline at `dfafabd` was 464.                                                                                                                                                                                                                                                                                                                                                                           |
| `bun run test:browser`                           | 5 pass: the existing guest test, the new backup restore, and three no-WebGL variants. Rerun with the attempt fence.                                                                                                                                                                                                                                                                                                                      |
| Regression proof                                 | `tests/reconstruction-sync.test.tsx` fails without `b411643`. The recovery race test pauses the real `runForProject` at its scripted model call, runs recovery, then releases the old call. Against the `2314e32` backend, the stale budget edit lands; with the fence it is rejected and the newer attempt finishes. It passed 5 of 5 repeated runs. Other recovery tests cover each fenced writer, lost deletions and re-armed timers. |
| Native XCTest                                    | Not run on Fedora. PR #37 CI `native` passed on macOS.                                                                                                                                                                                                                                                                                                                                                                                   |
| Production build, deployment, `convex dev`       | Not run, by instruction. `convex/_generated` needed no changes because no modules were added.                                                                                                                                                                                                                                                                                                                                            |
| Authenticated Clerk/Convex flows, live providers | Not run. No credentials were used.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Physical iPhone capture/transfer                 | Not run. This needs a LiDAR device.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Real backup restore drill                        | Not run. Recovery is verified only with convex-test restored-state fixtures.                                                                                                                                                                                                                                                                                                                                                             |

## Private preview

`http://100.84.133.110:43771/` (Tailscale only; helper preview `a9f06374b6df2857bb2d`). It returned HTTP 200 with its assets on Fedora. Rendering and laptop reachability have not been checked. This worktree has no `.env*`, so the app runs in guest/local mode with no Clerk or Convex; signed-in flows cannot be exercised here. Stop it with `python3 ~/.agents/skills/remote-preview/scripts/preview.py stop a9f06374b6df2857bb2d`.

Suggested Mac checks: open the sample room, place a product, use Download room, then import the file in a private window. Open the floor plan with WebGL disabled and check that the keyboard focus outline is visible and scaled correctly.

## PR dependencies

1. PR #36 (`839fd31`) is merged into this branch. Merge #36 first, or close it as superseded when this lands.
2. PR #37 (`dfafabd`) is this branch's base. Open this branch as a draft against `t3code/production-architecture-review`, or against `main` after #37 merges.
3. `453aa39` fixes PR #37's failing `checks` job. It can instead be cherry-picked onto #37.

## Remaining release risks

- Nothing has been verified against staging: Clerk, Convex, provider model access, webhook delivery, and a cross-device restore signed in on two browsers.
- No real Convex backup/restore rehearsal has been run, and restore time is not measured. Backups themselves still keep deleted user data until they expire; the retention policy is still undecided.
- Recovery cannot cancel an older run's in-flight model, search, merchant or image requests. They still finish and are billed. Their reply and project writes are rejected, but shared merchant-cache and catalog-observation writes can still land.
- Pending assets without an `attempt` (older rows) are only repaired by the next queue or retry.
- Nothing has been run on a physical iPhone: capture, interrupted upload, app termination, QR expiry, the release origin allowlist, and TestFlight signing.
- Performance on low-end hardware has not been measured.
- Payments, spend limits, usage quotas, and the global kill switch are deferred. Signed-in users can still cause unbounded AI spend.

## Draft PR description

**Title:** Verify release recovery, restore and no-WebGL fallback on top of production hardening

**Summary**

- Fall back to the floor plan when WebGL2 is unavailable, and keep a visible keyboard outline (fixes PR #37's failing browser check).
- Include PR #36's stale-discovery replacement, and wait for a cloud project's design before applying a cached reconstruction so discoveries are saved to the account.
- Make `operations:recover` resume every lifecycle lost when a backup is restored. Reruns are fenced by a per-reply `runAttempt`, and project deletions leave tombstones.
- Add tests for restoring after a backup, fencing a stale reply chain, a multi-chunk source round trip, and restoring a downloaded room into a fresh browser.

**Depends on** #37 (base) and #36 (merged in).

**Testing**

- `bun run typecheck`, `bun run typecheck:shared`, `bun run lint`, `bun audit`: pass.
- `bun test`: 474 pass. `bun run test:browser`: 5 pass on Fedora Chromium.
- Not run: production build, deployment, authenticated staging flows, a real backup restore, native tests on Fedora, and a physical iPhone.
