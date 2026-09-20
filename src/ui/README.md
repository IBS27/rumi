# rumi UI kit

The interface follows the "Plaster" direction: the room view is the base layer
of every workspace screen, and everything else floats over it as tinted
plaster panels. One saturated colour (teal) for actions; ochre only for
"estimated" and fit warnings. Reference mock: `docs/design-new.html`, Plaster
tab (`docs/design-parts/05-plaster.html`).

## Rules

- Build screens from these components. Do not write ad-hoc `<button>`,
  `<input>`, or panel markup in feature code.
- Colours, radii, shadows and typefaces come from the tokens in
  `src/styles.css` (`@theme`). Use the Tailwind utilities they generate
  (`bg-sage`, `text-mute`, `rounded-panel`, `shadow-float`, `font-display`).
  Never hard-code hex values in feature components. The 3D viewer and SVG
  illustrations are the one exception; keep their colours equal to the tokens.
- Copy is sentence case and tells the user what happens ("Import a scan",
  "Save changes"). No all-caps labels, no taglines, no numbered steps.
- Estimated vs confirmed must stay visible wherever a measurement appears
  (`Pill tone="estimated"`, the dot markers in the scan dock).
- Sample data is labelled (`<Pill>sample</Pill>`).

## Components

| Component                                                             | Use for                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TopBar`, `Brand`                                                     | The app header. `title` for the room name, actions as children.                                                     |
| `Button`                                                              | Every button. `variant`: `primary` (one per screen), `soft` (default), `quiet`, `danger`. `size`: `sm`, `md`, `lg`. |
| `Segmented`                                                           | Exclusive view switches (3D view / Floor plan).                                                                     |
| `Chip`                                                                | On/off overlays and filters (Walls, Dimensions, Fit checks).                                                        |
| `Pill`                                                                | Status labels. Tones: `neutral`, `estimated`, `ok`, `warn`, `locked`.                                               |
| `Panel`                                                               | A tinted surface in normal flow. Tones: `chalk`, `stone`, `sage`, `blue`, `blush`.                                  |
| `FloatingPanel`                                                       | A panel positioned over the room view. Position with `className`.                                                   |
| `Field`, `TextInput`, `TextArea`, `NumberInput`, `Select`, `Checkbox` | Forms. Numbers are meters or degrees.                                                                               |
| `Notice`                                                              | Inline or floating messages: `info`, `warn`, `error`. Say what happened and what to do.                             |
| `Dialog`                                                              | Modal wrapper around the native `<dialog>`.                                                                         |
| `Heading`, `Display`, `Muted`                                         | Text roles.                                                                                                         |
| `cx`                                                                  | Class joiner.                                                                                                       |

Import from `src/ui` (`import { Button, FloatingPanel } from "../../ui"`).

## Screen layout

```
<div class="flex h-full flex-col bg-chalk">
  <TopBar … />
  <main class="relative min-h-0 flex-1 bg-sage">
    <RoomViewer />              absolute inset-0, the base layer
    <FloatingPanel left-4 top-4 />   lists, editors, conversation
    <ViewerTools />             top-right controls
    <Notice floating />         messages, top centre
    <FloatingPanel right-4 top-4 />  products, budget (design workspace)
  </main>
</div>
```

Floating panels hug their content (`max-h-[calc(100%-32px)]` + `overflow-auto`)
unless they end in a composer, in which case they stretch (`bottom-4`).
Keep them narrow: 252px for the scan dock, about 300px for chat and products.

## Adding a component

Add it to `src/ui/`, export it from `src/ui/index.ts`, document it in the
table above, and use tokens only. Prefer one component with a `variant` or
`tone` prop over several near-duplicates.
