# Planner agent

## Position in the pipeline

```
user prompt
    |
    v
Main agent  --- budget + room ------> Planner agent
   (chat)                                  |
      |                            planned items
      |                                    |
      |                                    v
      +---- style + color palette ---> Search subagent ---> products
```

The main agent owns the conversation. The planner turns the confirmed room and the
budget into a bounded shopping list. The search subagent (`convex/search.ts`) then
fills one list entry at a time. The planner never searches the web, never picks a
merchant, and never places an object.

The planner exists so the search subagent is never given an open-ended request.
Every task it receives carries an item category named by the main agent, a price ceiling,
and a footprint ceiling. Categories are open strings rather than a fixed room-specific
list.

## Responsibilities

| Decides                                              | Does not decide                  |
| ---------------------------------------------------- | -------------------------------- |
| Which categories the room still needs                | Which product to buy             |
| How much of the remaining budget each category gets  | The actual price of an item      |
| The footprint ceiling each category must fit         | The final placement coordinates  |
| Which tags to exclude, from the brief's restrictions | The style wording sent to search |
| The order in which categories are searched           | Whether a proposal is applied    |

## Inputs

The planner reads, and nothing else:

- `RoomSnapshot` — dimensions, openings, and the objects already in the room, including
  `owned` and `locked` flags.
- `DesignBrief` — the prompt, styles, `budgetCents`, and `restrictions`.
- The priced total of the current selection, from `selectionTotal`, so the planner works
  against **remaining** budget rather than the original number.

Style terms and the color palette are **not** part of the planner's output. The main
agent attaches them when it calls `searchProducts`, as in the diagram. The planner may
read `brief.styles` as context for choosing categories, but must not echo them into a
planned item.

## Output contract

Add to `shared/contracts/index.ts`. `footprintSchema`, `categorySchema`, and
`searchTaskSchema` arrive with the agent branch; land that first.

```ts
export const plannedItemSchema = z.object({
  category: categorySchema,
  query: z.string().min(1),
  maxPriceCents: z.number().int().positive(),
  maxFootprint: footprintSchema.nullable(),
  excludeTags: z.array(z.string()),
  priority: z.number().int().positive(),
});
export const designPlanSchema = z.object({
  summary: z.string(),
  items: z.array(plannedItemSchema),
});
export type PlannedItem = z.infer<typeof plannedItemSchema>;
export type DesignPlan = z.infer<typeof designPlanSchema>;
```

Field notes:

- `query` is a short noun phrase describing the item, such as `"arc floor lamp"`. No
  price text, no dimensions, no style adjectives — the search subagent's
  `buildExaQuery` already appends the ceilings and the style terms.
- `maxPriceCents` is a ceiling, in integer cents. There is no price floor and no target
  price. A cheaper product is always an acceptable result.
- `maxFootprint` is width × depth in meters, or `null` when the planner cannot bound the
  footprint. Height is not bounded; the placement validator catches ceiling conflicts.
- `excludeTags` is lowercase and comes from `brief.restrictions`. The search subagent
  matches it against product tags and the product category.
- `priority` is 1-based and strictly ascending across the plan. Lower runs first, so the
  items that define the room are searched before the accents.

A `PlannedItem` becomes a `SearchTask` when the main agent merges in `styleTerms`. The
remaining `SearchTask` fields map across unchanged.

## Rules the code must enforce

The model chooses what the room needs. Code enforces everything below, in
`shared/planner/`, before the plan reaches the main agent. A plan that breaks a rule is
rejected with a message the planner can act on, the same way `proposeDesign` rejects a
bad proposal today.

1. **The plan fits the budget.** `sum(items.maxPriceCents) <= brief.budgetCents - selectionTotal(room, products)`.
   Ceilings are allocated, not wished for: a 4-item plan against $500 cannot hand every
   item a $500 ceiling.
2. **No duplicate categories.** One entry per category per plan.
3. **No category the room already has.** Skip a category that an `owned` or `locked`
   object already covers, unless the user's instruction explicitly asks to replace it.
4. **Footprints come from free space, not from the model.** Derive `maxFootprint` in code
   from the room dimensions minus the axis-aligned footprints of the existing objects.
   Prefer a conservative rectangle over an optimistic one. Emit `null` rather than a
   guess when no sensible bound exists.
5. **Restrictions become `excludeTags`.** `"No drilling"` produces an exclusion, not a
   sentence dropped into `query`. Keep the mapping in code so it is testable.
6. **Plan size is capped at 6 items.** The main agent's tool loop stops at 10 steps, so a
   longer plan cannot be searched in one pass.
7. **`priority` is normalized in code**, to `1..n` in the model's order, so the main agent
   can rely on it.

## Replanning

`SearchTaskResult.failures` reports why candidates were dropped, per stage. When a
category returns no products, the main agent may ask the planner for a revised plan. The
revision reallocates the unspent ceiling of the satisfied categories to the failed one,
subject to rule 1, and may drop the lowest-priority entry. It must not raise the total.

Replanning is a new plan from current state, never an edit of a previous plan object.

## Where the code goes

| Path                      | Contents                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/planner/index.ts` | Pure helpers: remaining-budget math, free-space and footprint derivation, restriction-to-tag mapping, plan validation and normalization. No model calls, no Convex imports. |
| `convex/planner.ts`       | `internalAction` `planRoom({ roomId, instruction })`. One `generateObject` call against `designPlanSchema`, then the `shared/planner` validation. Returns a `DesignPlan`.   |
| `tests/planner.test.ts`   | Covers `shared/planner` against the fixtures, with no network and no deployment.                                                                                            |

Follow the shape of `convex/search.ts` and `shared/search/index.ts`: the Convex action
holds the model call and the I/O, the shared module holds the logic worth testing.

## Acceptance criteria

The task is done when `tests/planner.test.ts` covers each of these against
`sampleRoom` and `sampleBrief`:

- A plan whose ceilings sum above the remaining budget is rejected.
- Remaining budget accounts for products already selected in the room, not just
  `brief.budgetCents`.
- A plan containing `bed` or `desk` for the sample room is rejected, because both are
  owned and locked.
- Duplicate categories are rejected.
- A derived `maxFootprint` leaves the existing bed and desk footprints out, and a product
  at exactly that footprint passes `placementIssue` somewhere in the room.
- `"No drilling"` in `brief.restrictions` appears in every item's `excludeTags`.
- A 7-item plan is rejected; `priority` is normalized to `1..n` on a valid plan.
- Each planned item, merged with style terms, parses as a `SearchTask`.

`bun run typecheck`, `bun run lint`, and `bun test` pass.

## Out of scope

Deliberately excluded from this first version, to keep the contract stable while the
search path is being built:

- A price floor or target price. `maxPriceCents` is the only price field.
- Color palette and material constraints. These stay on the main agent to search edge.
- Height ceilings and mounting type. The placement validator is the check for now.
- Shipping, tax, and quantities above one per category.
- Move, remove, and replace operations. The proposal contract is additions-only, so a
  plan can only ask for new items.

## Open questions

- Does replanning belong to the main agent's loop, or should `planRoom` accept the prior
  failures and return the revision itself?
- Should the planner emit an explicit "nothing to add" plan, or should the main agent
  treat an empty `items` array as that signal?

Read [docs/contracts.md](contracts.md) before changing any shared shape, and update
contracts, producers, consumers, fixtures, and tests together.
