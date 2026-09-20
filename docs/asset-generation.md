# Image-to-3D assets

## Scope

The first asset pipeline turns product-gallery photos into an approximate parametric
Three.js scene. It is intended for recognizable room-layout previews with the correct
outer footprint. It is not photogrammetry and does not claim manufacturer-level mesh,
texture, hidden-surface, or construction accuracy.

## Flow

1. Search stores a `ProductCandidate` with product-gallery image URLs and resolved outer
   dimensions.
2. `convex/assets.ts:generateForProduct` downloads up to eight usable JPEG, PNG, or WebP
   gallery images. Each image is limited to 5 MB.
3. Astra first selects up to four source images. A printed dimension drawing is mandatory
   when one exists; the remaining slots must use distinct roles such as front, side,
   back, or three-quarter. Duplicate crops and repeated angles are rejected.
4. Only those selected images, together with the product name/category and dimensions,
   enter the reconstruction call. Astra returns structured data only; it does not return
   or execute JavaScript.
5. `parametricModelSchema` validates the selected image roles and a maximum of 64 visible parts, their identifiers,
   materials, colors, normalized transforms, and bounds.
6. The asset is stored as `ready` with `accuracy: "approximate"`; the product receives
   its asset ID.
7. `ParametricModel.tsx` turns each validated part into Three.js geometry and scales X,
   Y, and Z by the catalog width, height, and depth in meters.

The action remains internal until authentication and ownership are implemented. Asset
generation should run after product recommendations return, so the user can see search
results while 3D previews are being prepared.

## Coordinate contract

- The room and rendered asset are right-handed and Y-up.
- X is width, Y is height, and Z is depth.
- Part positions and sizes are normalized against the product's outer dimensions.
- X and Z are centered around zero; Y starts at the floor.
- Rotations are XYZ Euler radians in normalized space. A Three.js cylinder points along Y before rotation.
- Scale each primitive by its normalized size, rotate it, then translate it. Apply
  the catalog width, height, and depth to the enclosing group last.
- The rotated geometry must stay within X/Z [-0.5, 0.5] and Y [0, 1]. Bounds use
  each primitive's rotated extents with only a 0.000001 roundoff tolerance.
- The application-provided dimensions are authoritative for scale. Astra cannot replace
  them with dimensions inferred from a photograph.

## Safety and failure behavior

- Only image content types are accepted; HTML and failed/hotlink-protected URLs are
  skipped.
- No user- or model-authored JavaScript is evaluated.
- Out-of-bounds parts, duplicate IDs, invalid colors, empty scenes, and excessive part
  counts fail schema validation.
- If no product image can be downloaded, no model call is made.
- If Astra detects a dimension drawing but omits it from the selected four, generation
  stops before reconstruction.
- Selected images must have unique gallery indices and unique view roles.
- Products without resolved dimensions cannot start generation.
- A generated scene is always marked approximate. A future manufacturer GLB remains the
  preferred high-accuracy asset when available.

## Configuration

`OPENAI_API_KEY` and `RUMI_ASSET_MODEL` are backend deployment variables.
`RUMI_ASSET_MODEL` defaults to `gpt-6-astra`. Never expose either variable with a
`VITE_` prefix.

## Room-viewer integration

`RoomViewer` accepts validated scenes keyed by asset ID. When a room object's `assetId`
matches a supplied scene, `ParametricModel` renders the generated parts at the object's
current dimensions and placement. If the scene is absent or still pending, the existing
dimensionally accurate box remains as the fallback. The UI therefore does not wait for
asset generation and a failed asset never makes an object disappear.

The current product and asset queries remain internal until authenticated product
placement is implemented. That future boundary should load only the ready asset records
referenced by the room and pass their validated `scene` values to `RoomViewer`; it must
not expose the generation action or provider credentials to the browser.
