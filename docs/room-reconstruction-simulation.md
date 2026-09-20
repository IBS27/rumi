# Simulated rooms from scans

Detailed ZIP imports can produce a clean, furnished Three.js scene through GPT-6
Astra. The original photo-textured mesh remains available through **Captured
surfaces**. The generated view is **Simulated room**, with procedural finishes and
assembled furniture instead of photo projection.

## Processing

The import worker validates the original package, then prepares up to sixteen
photographs at 1024 pixels on the longest side. Camera selection spreads views
across positions and directions. It also samples at most 1,200 measured triangles,
including their ARKit classifications. Photos retain calibrated camera transforms
and intrinsics. Cameras and triangle samples subtract the original RoomPlan origin
once; furniture edits do not change that coordinate frame.

The same decoded photographs supply bounded wall/floor color observations. A
10-by-10 grid per surface is projected into calibrated photos, rejects door and
window areas, and requires measured depth agreement. Clipped exposure and grazing
views are discarded. Up to three observations per surface side accompany the
photos. These are observed RGB values under capture lighting, not calibrated
reflectance; Astra still compares views to resolve lighting and mixed finishes.

The authenticated browser sends this bounded evidence to `roomReconstruction:start`.
The backend validates it, stores it privately in Convex storage, and queues a job.
Jobs are deduplicated per owner by a hash of the validated evidence, including its
contract version and appearance revision. A new appearance revision regenerates older
flat-material scenes once, while preserving the old cached result. Reloads reattach to the same job or completed scene. Synthetic
fixtures never automatically invoke the paid model.

GPT-6 Astra first identifies surface finishes and the appearance of each captured
furniture item, and identifies additional objects visible in photos. The scan inventory
is not exhaustive: separate lamps, mirrors and other observed items receive estimated
placement, dimensions, confidence and supporting photo references. These appear in
Scan details as editable entries marked **From photos**. Attached headboards and
backing panels stay within the parent assembly, using expanded visual bounds when
needed. Existing scanned dimensions and transforms remain unchanged.

It then models furniture in batches of three, with three batches in flight and up to 48 parts
per object. Parts are boxes, cylinders and spheres with photo-derived base colors,
roughness, and procedural wood grain, weave, carpet, tile, stone or plaster. Texture
repeat dimensions are meters, independent of furniture size. Fabric boxes have
softened edges and shallow cloth undulation in the renderer. Hard furniture has
small physical bevels. Fabric and plaster detail affects bump shading without
darkening the base color. Repeated finishes share textures within the viewer.
Window-oriented lighting and a local reflection environment give surfaces shape.
A bounded correction pass retries
invalid geometry. Unknown surface colors remain null and render with a neutral
finish; inferred furniture appearance includes confidence scores. A surface can have
multiple finish regions, including carpet/tile transitions or different colors on
each side of a partition. Region polygons use the measured surface’s local XY plane
and are clipped to its outline and opening holes. These are procedural materials,
not projected photographs.

Every completed scene must retain the original room and furniture IDs and include
a model for each discovered item. Discovery IDs cannot collide with scan IDs.
Photo-derived placement must fit within room bounds. Parts must fit their declared
visual bounds after rotation. Attached details may extend the parent visual bounds
by at most two meters per side, while preserving its measured body. Astra cannot
change measured positions, dimensions, walls or openings, execute JavaScript, or
load external textures. Scenes are limited to 2,000 parts and 750 KB. Evidence is limited to 5 MB.

The progress panel reports photo analysis, furniture modeling counts and final
preparation. Failed jobs preserve the source scan and support up to three attempts.
Analysis and each wave of up to three concurrent furniture batches have separate
eight-minute deadlines and scheduled timeouts. Plans and completed batches are stored
between actions; retries resume them instead of repeating successful provider calls.
Attempt and stage numbers fence stale completions and old watchdogs, preventing a permanently
pending job. There are at most two active jobs and 24 new jobs per owner per day.

## Overview and first person

Both modes render the same generated furniture assemblies at the room objects'
current dimensions and transforms. Furniture edits therefore apply in both modes.
The **Walls** toggle controls walls and their door/window assemblies in both modes.
The default **Cutaway** overview lowers camera-facing exterior walls to 0.75 m;
interior partitions stay full-height. Disable Cutaway for full walls. **Walk inside**
always restores full wall height and adds a ceiling at the measured room height.
Floors have a thin solid base. Doorways are polygon differences, including notches
at the floor, so triangulation cannot close floor-reaching openings. Door leaves
are shown open so the view remains traversable.

Half-resolution ambient occlusion adds shading at wall joints and furniture
contacts. Color rendering retains its full resolution. The overview renders on
demand; walking renders continuously. Directional shadows are cached and refreshed
when geometry, wall visibility or lighting changes. Lowering a wall while orbiting
also invalidates its shadow. Concurrent model requests preserve inventory order,
serialize progress updates and cancel siblings if a batch fails.

Walking uses the existing measured-layout collision system, including doorway
clearance and furniture footprints. Internal doors and passages remove the walkable
part of a wall's collision footprint after checking sill height and headroom.
Jambs, windows, narrow openings and missing floor remain blocking. It does not treat gaps beneath tables as space
the viewer can walk through. Returning to **Captured surfaces** uses the original
scan and its original collision layout, as before.

## Setup and limits

The deployment needs its existing `OPENAI_API_KEY`. The reconstruction model is
explicitly `gpt-6-astra`; there is no silent model substitution. Sync the new
`roomReconstructions` table and functions to the correct personal development
deployment before using the feature. Existing tables need no migration. Frontend
changes alone cannot activate the processing service.

This produces an approximate architectural simulation. It does not recover
manufacturer meshes, separate individual objects from the raw LiDAR mesh, or guarantee exact dimensions for items RoomPlan missed. Source photos and mesh remain preserved in the original
ZIP. The generated scene is cached in the backend; Download room currently exports
the original ZIP, layout edits and applied discovery IDs, and reimport reconnects to the cached generation
for the same signed-in owner. Edits and removals of discovered objects survive reload and reimport; cached results
only add previously unapplied IDs. Offline reconstruction is not available.

Tests cover coordinate normalization, camera selection, calibration scaling,
bounded model output, physical texture scale, clipped finish regions, photo evidence,
invalid IDs, correction failures, ownership,
deduplication, retry limits and stale-job completion. A live provider smoke test
uses synthetic evidence and cannot establish fidelity to a real furnished room.
Visual comparison and walking through the user's actual room still require the
updated backend and an accessible browser session.
