# Room reconstruction

## Working locally

Run `bun install` and `bun run dev`. Choose **Explore a sample room**, or import the raw JSON produced by `JSONEncoder().encode(finalCapturedRoom)` in the native RoomPlan app. The bundled L-shaped room is synthetic. Files are limited to 10 MiB.

The workspace renders walls with opening cutouts, captured floor polygons, door/window outlines, and dimensioned furniture boxes. Select furniture to edit its name, category, dimensions, position, rotation, and measurement status. Reset restores that object's original scan values; undo retains the last ten changes in the current session. Changes are saved in this browser, separately for each signed-in identity. Download preserves the edited room and the original scan for reimport. Browser storage is not a cloud backup; clearing it removes local rooms.

In **3D view**, choose **Walk inside** for an eye-level first-person view that fills the browser viewport. The header collapses and both sidebars slide away; **Exit first person** or Escape restores them with their selections and chat state intact. These transitions respect reduced-motion preferences. Drag with a mouse or finger to look around, use WASD or arrow keys to move, and Q/E to turn with the keyboard. The on-screen arrows support holding with touch, a mouse, or Space/Enter. **Reset position** returns to the starting location and direction.

Walking requires a captured, nearly level floor with enough unobstructed standing space. Movement stays within a captured floor polygon and stops at wall segments and furniture footprints, including rotated or tilted furniture. Doorways remain boundaries; this is a single-room walkthrough. Missing or steep floors and rooms without a clear starting position show an explanation instead of inventing walkable space. Small floor-height changes up to 18 cm are allowed only where a complete standing footprint fits. This does not add stairs, multiroom navigation, photographic textures, or detailed furniture models. Camera movement is temporary and does not edit or save room geometry.

Scanned dimensions remain estimates until reviewed. Detection confidence is not a measurement error bound. Overall room extents are bounding-box dimensions, not an assertion that the room is rectangular. Captured floor area is distinct from usable empty space. Free-space regions, clearance analysis, multiroom stitching, curved walls, photorealistic assets, and editing wall geometry are not implemented. Existing rectangular placement checks refuse polygon rooms until polygon-aware fit validation is available. Exports without floor polygons retain walls without inventing a floor boundary.

## Private preview and Google sign-in

Use [the private development preview](http://fedora.taile44743.ts.net:39415/) with Tailscale connected for remote browser sign-in. Clerk's edge service rejected Google OAuth requests whose return URL used the raw Tailscale IP, while the same flow reached Google from the Tailscale DNS hostname. Adding the IP URL to Clerk's redirect allowlist did not resolve its 403 response. The hostname URL is also registered explicitly. This was not a missing Google provider configuration: Clerk development instances use shared OAuth credentials.

Set `RUMI_PREVIEW_HOST` in `.env.local` to the exact proxy hostname, without a scheme or port. Vite allows only that additional hostname and redirects requests to its bound IP/port to the hostname, preserving paths and query strings. Other checkouts can leave it blank. Use a private HTTPS reverse proxy when available so Clerk can use secure browser APIs and cookies. Never disable Vite's host checks globally.

## Code boundaries

- `shared/contracts/index.ts`: canonical rectangle/polygon room union, surfaces, and furniture. Existing rectangle producers remain compatible.
- `shared/capture/roomplan.ts`: bounded input validation, column-major transforms, origin normalization, object base positions, category mapping, preserved originals, and saved-room format.
- `shared/capture/surfaces.ts`: shared surface triangulation inputs and floor area.
- `shared/capture/walkthrough.ts`: first-person spawn selection, standing clearance, and movement collision checks.
- `src/features/room-editor/`: import, local persistence, inspector, and React Three Fiber viewer.
- `src/features/room-import/PhoneCapture.tsx`: authenticated QR modal and uploaded-file import.
- `convex/captures.ts` and `convex/http.ts`: owner-bound capture sessions, claim/upload endpoints, token expiration, retry handling, and cleanup.

## Clerk and live pairing setup

The Rumi Clerk development application is created and this checkout has its public key configured. Its `convex` JWT template and the personal Convex deployment's issuer variable are configured. The backend is synced to `utmost-cow-946` (`rumi-4592b:rumi:dev/srinivas`) and QR pairing is enabled in this checkout. Browser-to-backend transfer was verified using a scripted phone client and sample scan; physical iPhone verification remains pending. File import and the sample work without these services.

For another checkout or deployment:

1. Use the Rumi Clerk **development** application (`app_3JYwPQ79TDcwzlVXo0wBAggmm7q`), or create an isolated development application if needed.
2. Ensure the Clerk JWT template `convex` exists, with audience `convex`. The existing development issuer is `https://wondrous-hagfish-7431.clerk.accounts.dev`.
3. Put the public `pk_test_…` key in this checkout's `.env.local` as `VITE_CLERK_PUBLISHABLE_KEY`. Preserve its own `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, and `VITE_CONVEX_SITE_URL`. Never put secret keys in `VITE_` variables.
4. Follow `convex-workflow.md`: verify ownership of the personal dev deployment and obtain authorization before syncing. Set that deployment's `CLERK_JWT_ISSUER_DOMAIN` to the Clerk issuer, then sync the reviewed backend using `bunx convex dev --once`.
5. Set `VITE_CAPTURE_PAIRING_ENABLED=true` and restart Vite after the backend is ready. Until then, the UI explicitly reports that phone pairing is not configured.
6. Sign in, create a QR session, and test the native claim/upload flow against that deployment. Configure the native app's backend origin allowlist using the `.convex.site` URL, not the `.convex.cloud` client URL.

No Clerk secret key is needed for this integration. Authentication uses Clerk tokens verified by Convex. An unconfigured backend has no auth providers and denies owner operations. Code generation may require the issuer environment variable even before deployment. Run `bun run convex:codegen` after configuring it.

See `room-capture-pairing.md` for the native integration contract. Uploaded scans and their session records expire 24 hours after session creation. Local edits/downloads are independent of this temporary transfer. Only the owner can obtain the storage URL; that URL itself is a bearer download link and should not be shared or logged.

## Verification

Run `bun run typecheck`, `bun run lint`, and `bun test`. Tests cover geometry/origin conventions, door cuts, unknown categories, malformed raw and saved files, preserved originals, refusal of rectangle-only placement checks, owner isolation, token claims, expiry/cancel, and idempotent HTTP uploads using `convex-test`.

Browser checks cover sample rendering, selection and dimension edits, reload persistence, reset, removal/undo, floor-plan mode, malformed-file rejection, and importing a separate RoomPlan sample. Clerk sign-in/sign-out was verified in the browser with a temporary test account (removed afterward), including the `convex` token audience and issuer. Live checks decoded the browser-generated QR, claimed it through the deployed endpoint, uploaded a sample scan, and confirmed automatic browser import and 3D rendering. Identical claim/upload retries, competing claims, invalid tokens, malformed rooms, conflicting upload retries, anonymous reads, and cancellation were exercised against the deployment. Temporary users and uploaded test files were removed. This verifies the web/backend transfer; camera scanning and native app behavior still need a physical iPhone test.
