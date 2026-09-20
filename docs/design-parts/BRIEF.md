# Rumi UI redesign brief (shared by all five designs)

## What Rumi is
An AI interior designer. You scan your room with an iPhone (Apple RoomPlan), review the captured walls and furniture, give a style brief and a budget, and an agent assembles a room from real purchasable products across retailers. You walk the 3D room, edit placements, talk to the agent, and see the budget update. Fit checks (doorways, clearances) are visible. Estimated vs. confirmed measurements are always distinguished. Payments are paused, so no checkout screens.

Audience: people furnishing a real room, on a laptop. Primary job: get from "scan" to "a coordinated room I can buy" with confidence about fit and cost.

## Why the current UI was rejected
It is generic generated output: tracked-out ALL-CAPS eyebrow labels above every heading ("YOUR ROOM, IN PERSPECTIVE", "ROOM WORKSPACE"), a brand tagline ("spaces, understood."), stats joined with middle dots, 01/02/03 step markers that explain nothing, identical rounded cards with the same grey shadow, Inter everywhere, and copy that sells instead of guides. Do none of that.

## Hard rules
- No eyebrow labels, no all-caps tracking labels, no taglines, no "A · B · C" meta strings, no "→" on buttons, no numbered steps unless the content is truly sequential, no single-word colour/italic accents in headlines, no monospace for data labels unless the design's whole voice is monospace, no gradient washes as decoration, no identical-card grids with one radius and one shadow on everything.
- Avoid the calibration clichés: cream #F4F1EA + terracotta accent; near-black + acid green; broadsheet hairlines-and-zero-radius newspaper.
- One or two typefaces, loaded from Google Fonts. Never Inter, Roboto, Arial, system-ui as the primary face.
- Copy is sentence case, plain, and tells the user what to do. Buttons say what happens ("Import a scan", "Save changes"). Empty states invite action. Sample data is labelled as sample.
- Meters for geometry, dollars for money. Keep "estimated" vs "confirmed" visible wherever a dimension appears.
- Quality floor: readable contrast, visible focus rings, works at 1280 wide, sensible at 900 wide. No page-load animations.

## Screens to design (all three, in this order, in one fragment)
1. **Start.** No room loaded. Actions: Scan with iPhone (opens pairing), Import a scan (RoomPlan JSON, drag-and-drop anywhere), Open the sample room. Account entry (sign in / avatar). Brand: "rumi", lowercase.
2. **Room review.** A captured room is open: "The corner living room" (sample). Data: 6 wall segments, 5 existing objects, 18.4 m² floor area, room extents 5.20 × 3.55 × 2.60 m. Objects (width × depth × height, m): Sofa 2.10 × 0.95 × 0.82 (confirmed), Coffee table 1.10 × 0.60 × 0.42 (estimated), Bookshelf 0.80 × 0.30 × 1.90 (estimated), Armchair 0.85 × 0.90 × 0.78 (confirmed), Floor lamp 0.35 × 0.35 × 1.60 (estimated). Viewer: 3D view / Floor plan toggle, walls and dimension overlays toggle, a stand-in for the 3D canvas (draw a floor-plan SVG or a simple isometric; do not leave a grey box). Inspector for the selected object (Coffee table): name, category select, dimensions, position x/y/z, rotation, "measurements confirmed" checkbox, keep-in-place lock, Save changes / Reset to scan / Remove. Undo and Download room. Status "Saved on this browser".
3. **Design workspace.** The agent has produced a design. Brief: "Warm, minimal living room. Keep the sofa. No drilling. Budget $600." Conversation: user message above, agent reply explaining what it chose and one trade-off ("Chose the wool rug over the jute one to stay under budget; the arc lamp reaches over the sofa without a side table."), one follow-up question about outlets. Products (name, price, merchant, size, availability): Arc floor lamp $79 Studio sample catalog 0.30 × 1.80 m in stock; Woven wool rug $129 2.00 × 1.40 m in stock; Low oak cabinet $149 1.20 × 0.40 × 0.55 m in stock; Quiet forms print $39 0.50 × 0.70 m low stock. Budget: $600 limit, $396 selected, $204 remaining; estimates until checkout. One fit warning: "Cabinet blocks the doorway swing by 0.18 m" with a suggested placement. Locks: sofa kept, lamp locked by user. Views: walkthrough / overhead. A composer to send feedback to the agent.

Optional if it fits the design: the iPhone pairing dialog (QR code placeholder, "Open Rumi on your iPhone and scan this code", expiring in 4:59).

## Output contract
Write ONE file: `docs/design-parts/0N-<slug>.html` (N and slug given in your task). It is an HTML fragment, not a document:
- Root: `<section class="design" id="dN" data-title="<Design name>"> ... </section>` with a single `<style>` block inside it as the first child. `@import url(...)` for Google Fonts must be the first lines of that style block.
- EVERY selector must be scoped under `#dN` (e.g. `#dN .toolbar`). No `*`, `html`, `body`, `:root`, or bare element selectors. Set `box-sizing`, font, colour and background on `#dN` itself. No `<script>`. No external images; use inline SVG.
- Inside the section, render the three screens as `<article class="screen" data-screen="Start|Room review|Design workspace">` each with a `<div class="frame">` sized like a laptop window (1280 wide, natural height, min 760). Screens stack vertically with space between them. A short design note (2–4 sentences, plain prose: what the idea is, the typefaces, the palette) goes in `<aside class="note">` directly before the first article. Keep the note honest and unmarketed.
- CSS variables live on `#dN`.

## Process
Plan first (palette 4–6 named hexes, type roles, layout wireframe), check it against the "Hard rules" and clichés, then build. Review your own output: write a temp wrapper HTML in /tmp that includes your fragment, open it with the t3-code preview tools (preview_open, preview_screenshot) if available, look at the screenshot, fix what looks generic or broken, and repeat at least once. Delete the temp file. Do not touch any other file in the repo.
