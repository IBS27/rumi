# Single-session surface capture

Rumi Capture now runs RoomPlan and ARKit scene reconstruction in one world-tracking session. The room layout, furniture categories, surface mesh, camera poses, photos, depth maps, and depth confidence share the ARKit coordinate frame. The browser blends overlapping photographs onto the measured geometry. Furniture segmentation, inferred hidden surfaces, image-based category refinement, and coverage heatmaps are not implemented.

An optional [simulated room reconstruction](room-reconstruction-simulation.md)
uses Astra to generate solid finishes and furniture assemblies from this evidence.
It is separate from the measured, photo-textured surface view described here.

## User flow

On a LiDAR iPhone, scan one room slowly and show the sides of furniture. Finish once. RoomPlan presents its layout preview while a serial background queue packages the measured surfaces and selected photos. **Export scan** shares a single ZIP. **Export layout JSON** still shares Apple's final `CapturedRoom` bytes unchanged. If detailed capture fails, the layout remains available and **Retry saving detailed scan** retries packaging from retained session data. A successful ZIP survives relaunch alongside the layout JSON. Starting another scan deletes both only after confirmation.

Import the ZIP in the web workspace. **Captured surfaces** shows the original measured mesh with photos projected onto it. **Walls** hides faces classified by ARKit as walls, ceilings, doors, or windows. Unclassified faces stay visible. Missing or occluded photos leave neutral, shaded geometry. Photo coverage reports the fraction of mesh triangles textured, not room completeness or measurement accuracy.

Select furniture in the list to switch to the editable RoomPlan layout. Changing a furniture box does not modify the measured scene. Turning captured surfaces back on closes the furniture editor. The floor-plan view always uses the structured layout.

**Walk inside** works in both captured-surface and layout views. In captured surfaces, collision checks use the original RoomPlan layout so furniture edits do not move obstacles away from the measured scene. In the layout view, collision checks use the edited furniture. Collision geometry remains approximate RoomPlan geometry, not the detailed mesh. Exiting restores the panels and the chosen surface/layout view.

Large source packages are saved as Blobs in IndexedDB under the current identity. Only the small room snapshot and random local asset key go in localStorage. Download writes the original package plus validated edits to a new ZIP. Source photos, depth, and geometry remain unchanged. If browser storage fails, the current tab can still display and download the package; the UI asks the user to download before closing. Clearing browser storage removes these local copies.

The native app offers **Send to Rumi** for paired transfer of the complete ZIP, including surfaces, photos, depth, confidence, and layout. The browser opens it automatically through the same importer used for files. **Export scan** remains an offline backup; **Send layout only** is an explicit fallback when detailed capture is unavailable. See [the paired transfer contract](room-capture-pairing.md#complete-scan-transfer) for upload, retry, and rollout details. File import still needs no backend deployment.

## Version 1 package

A standard ZIP containing `manifest.json`, `roomplan.json`, and the buffers referenced by the manifest. Native export uses ZIP STORE with IEEE CRC32. The web importer also accepts deflated ZIPs, enforcing declared expanded-size limits before decompression. No paths are extracted to a filesystem and no external URLs are loaded.

The manifest has `format: "rumi.capture"`, `version: 1`, `coordinates: "arkit-world-meters-y-up"`, `room: "roomplan.json"`, `meshes`, `frames`, and `warnings`. An optional `synthetic` boolean defaults to false. Test fixtures set it to true and the viewer labels them as samples. A browser export additionally contains `edits.json` in the existing `rumi.room` format. Its original RoomPlan data must match this archive's `roomplan.json`.

Each mesh specifies a rigid column-major local-to-world `transform`, `vertexCount`, `faceCount`, and paths to:

- `positions`: packed XYZ Float32 little-endian vertices in anchor-local meters.
- `indices`: packed UInt32 little-endian triangle indices, three per face.
- `classifications`: one UInt8 per face, using iOS `ARMeshClassification` raw values 0 through 7.

Each frame specifies `image`, `depth`, `confidence`, image `width`/`height`, `depthWidth`/`depthHeight`, scaled JPEG pixel intrinsics `fx`/`fy`/`cx`/`cy`, a rigid column-major camera-to-world `cameraTransform`, and ARFrame `timestamp` in seconds:

- JPEGs keep the captured image buffer's native sensor orientation, with no UI-orientation rotation. Pixel origin is top-left. Intrinsics are scaled independently by the JPEG width and height ratios.
- Depth is packed Float32 little-endian camera-axis depth in meters. Rows have no padding. Unknown values remain unknown.
- Confidence is packed UInt8 with ARKit's 0/1/2 values, one per depth pixel. Its dimensions match the depth map.

The browser transforms anchor-local vertices to world space, then subtracts the **original** RoomPlan import origin exactly once. For photo projection, camera space looks down negative Z. `u = (fx * x / -z + cx) / width`, `v = (-fy * y / -z + cy) / height`. GPU textures use `flipY=false` with these top-left UVs. The original origin is retained even after furniture edits.

## Processing and limits

The recorder polls `ARSession.currentFrame` without replacing RoomPlan's AR session delegate. It allows one asynchronous high-resolution frame request at a time. Samples require normal tracking, sufficient view change, limited camera motion, a sharpness heuristic, and scene depth with confidence. The high-resolution frame supplies its own image, pose, intrinsics, depth, and confidence. If it is unavailable or lacks depth, the recorder saves the complete original frame instead, never mixing frames. JPEGs retain up to 2560 pixels on the longest side at quality 0.9. Capture is bounded to 160 frames, 96 MiB of frame payload, and 800 million source pixels. The user sees the saved-photo count and guidance for motion, tracking, duplicate views, and exhausted budgets. These thresholds require physical-device tuning; the count is not a room coverage metric.

After pausing the session, the recorder exports the final mesh anchors and their current transforms. It does not append stale versions of anchors. The mesh limit is 600,000 vertices, 300,000 triangles, and 2,048 anchors. Oversized mesh export fails explicitly while preserving the layout. It does not silently drop part of a room.

A web worker validates the ZIP, room, matrix rigidity, buffer lengths, finite vertex coordinates, index ranges, classifications, calibration, and JPEG dimensions before texture decoding. Packages are limited to 128 MiB compressed and expanded, 6,500 entries, and 800 million total JPEG pixels. Individual JPEGs are limited to 4096 pixels per side and 8 MiB. Processing has a two-minute timeout and terminates on import cancellation/unmount.

For each nondegenerate triangle, the worker selects up to three camera views using projected resolution and incidence angle. The centroid and every vertex must be in frame and agree with medium-or-high-confidence depth within `max(0.06 m, 2.5% of depth)`. Back-facing views and occluded samples are rejected. Exposure correction uses robust luminance ratios at the same measured points in overlapping photos; unmatched views retain their exposure and corrections are bounded. It does not normalize the average colors of different objects.

The worker projects each atlas pixel from its world-space position, checks depth again at that pixel, samples photos bilinearly in linear light, and blends by viewing angle, projected resolution, and distance from the image border. This avoids affine photo stretching across tilted triangles. A one-pixel gutter and lossless PNG output prevent neighboring texture islands from bleeding together. Atlas mipmaps are disabled to preserve island boundaries. Photo lighting is retained without applying the viewer’s lighting a second time. Unseen areas remain neutral.

Triangle textures share at most four 2048² atlases, with a twelve-million-texel packing target. Full-resolution source photos decode sequentially, one at a time; exposure thumbnails are at most 128 pixels on the longest side. Dense scans reduce each triangle’s texture allocation to stay within the atlas budget. The worker has a two-minute timeout and cancellation terminates it. Source photos, measured mesh positions, and room origin remain unchanged. Camera-pose refinement, multi-depth reconstruction, semantic furniture separation, and hidden-surface reconstruction are not implemented.

GPU resources and ImageBitmaps are disposed when switching views or rooms. The stored package allows future processing improvements without another capture, subject to the surfaces and photos actually recorded.

## Verification

TypeScript, lint, and the Bun suite check the web implementation. Capture tests cover package validation, camera orientation, translated room origins, depth occlusion, missing confidence, invalid buffers, ZIP expansion limits, and preserving originals through export/reimport. Atlas tests cover linear-light blending, robust exposure correction, per-pixel occlusion, and projective sampling on tilted geometry. Transfer tests exercise ownership, MIME and digest binding, malformed-package rejection, identical retries, canceled sessions, changed payloads, file limits, and expired-file cleanup.

Browser verification used both the colored-triangle fixture and a synthetic ZIP with 100 photos at 2560 × 1920, totaling 491.5 million source pixels and 11.6 MB of archive data. Import, worker processing, GPU rendering, floor-plan/layout switching, editing a furniture width, walkthrough entry/exit, ZIP download, and reimport passed. The downloaded ZIP retained the edit and source photos. Reload restored the edited room and regenerated its textured view from IndexedDB. These synthetic tests do not establish physical scan quality.

A standalone geometry/blending stress check with 300,000 repeated triangles and 160 candidate views completed in about 2.9 seconds on Fedora, producing two atlases. Its peak process RSS was about 776 MiB. It used synthetic pixel buffers and excludes real JPEG decode/PNG encode and phone performance; dense scans still require desktop memory. Full-resolution photos decode sequentially to avoid holding every source image in memory.

The iOS source and project membership were reviewed against Apple's API documentation. `CaptureArchiveTests` adds native checks for ZIP signatures, CRC32, central-directory offsets, retained source bytes, and failed writes. **The new native code and native tests have not been compiled or run in this Fedora environment.** Swift/Xcode are absent and agent device access is disabled.

Before shipping, run the native test target on the Mac and scan a furnished room with the LiDAR iPhone. Import that ZIP and compare orientation, shape, labels, dimensions, texture placement, runtime, thermal behavior, and file size. Include chairs with thin legs, reflective surfaces, dark upholstery, obscured furniture, an interruption, a storage failure/retry, export cancellation, and relaunch. Confirm the original JSON fallback still imports. Do not infer accuracy from the synthetic fixture or RoomPlan confidence.

## Apple references

- [Sharing a configured ARSession with RoomCaptureView](<https://developer.apple.com/documentation/roomplan/roomcaptureview/init(frame:arsession:)>).
- [RoomPlan and scene geometry in one session](https://developer.apple.com/videos/play/wwdc2023/10192/).
- [Scene reconstruction](https://developer.apple.com/documentation/arkit/visualizing-and-interacting-with-a-reconstructed-scene).
- [Camera intrinsics](https://developer.apple.com/documentation/arkit/arcamera/intrinsics) and [sensor image orientation](https://developer.apple.com/documentation/arkit/arcamera/imageresolution).
