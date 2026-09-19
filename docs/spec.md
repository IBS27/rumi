# rumi

AI interior shopping agent.

Current scope: payments, checkout, order handling, and delivery integrations are on hold. Keep product prices, budget calculations, and merchant links. The active milestone ends with a searchable product selection rendered in the user's room. Payment-related details below describe future scope.

Team split: two people own product search and recommendations; two own room capture and the initial 3D editor. Agree on shared room, product, and placement contracts before implementing either side. Product model acquisition and integration into the room need explicit ownership within the 3D team.

## Problem

People want a room that feels cohesive, but shopping requires disconnected searches, manual measurements, budget calculations, and purchases across stores. It is hard to know whether products will look good together, fit the space, or leave enough room for everyday use.

For Visa's HackMIT commerce challenge, the opportunity is to connect discovery, personalization, decision-making, trusted payments, and post-purchase support in one experience.

## Solution

An AI interior designer that turns room photos, a style brief, and a budget into an interactive room made from real, purchasable products.

> "Show us your room, tell us how you want it to feel, and set a budget. Walk through a design made from real products, change anything through conversation, and buy the approved plan."

- **Understand the room.** Ask targeted follow-up questions about dimensions, existing furniture, preferences, outlets, and restrictions such as no drilling. Let users confirm measurements or provide a guided scan. Distinguish estimated dimensions from confirmed ones.
- **Design the whole room.** Select furniture, wall decor, lighting, and other interior items across retailers. Balance aesthetic consistency, fit, availability, and the total budget, including shipping and tax. Identify estimates until checkout confirms costs.
- **Explore and edit.** Offer a walkable 3D room, an overhead layout editor, and saved alternatives. Users can click products, give conversational feedback, move items, and lock products or placements. Preserve existing possessions and locked choices during redesigns.
- **Explain tradeoffs.** A more expensive lamp can trigger cheaper wall art or reuse of an existing rug. Explain what changed, why it suits the brief, and how the full room stays within budget.
- **Check practical fit.** Show product dimensions and clearances. Check door and wardrobe openings, chair space, walking paths, outlet access, installation restrictions, and entrance fit when the necessary measurements are available. Flag unknowns instead of claiming verified fit.
- **Buy the approved design.** Every object links to a specific product and variant. Present exact items, merchants, and the final total for approval. Enforce spending limits and ask before substitutions. Show price or availability changes visually before the user approves them.
- **Support the finished room.** Track deliveries, provide placement and setup guidance, and help replace disappointing purchases. Keep a persistent room and ownership record so future redesigns start with what the user already has.

The differentiator is a complete, adaptable purchase plan across retailers, with visible spatial checks and a budget that stays intact as the user edits. Room visualization alone already exists in tools such as [IKEA Kreativ](https://www.ikea.com/us/en/customer-service/knowledge/articles/43460e1e-dd01-4fe8-86ac-74efecd7743f.html).

## Demo

Use one bedroom and a curated catalog to demonstrate the complete journey.

1. Upload room photos and enter: "I want a modern minimalist bedroom with wall decorations and cool lighting. My budget is $500."
2. Confirm room dimensions and answer two useful questions: what must stay, and whether drilling is allowed.
3. Generate a coordinated room using real products. Show the walkable view, overhead layout, product details, and running total.
4. Click a lamp and say: "Keep this lamp, make the room warmer, and save $80." Update the design and cart together while preserving the lamp.
5. Move an item into a doorway. Show the clearance conflict and suggest a valid placement.
6. Review the exact purchase plan and complete a sponsor-supported sandbox checkout or clearly labeled simulation. Demonstrate approval of a replacement if an item becomes unavailable.
7. Preview the delivery list and setup plan linked to the saved room.

Success means the edited room and cart agree, locked choices remain intact, fit problems are visible, and the approved purchase stays within the confirmed budget. The full vision includes ongoing delivery and ownership support; the demo can preview those later stages.

## Implementation

- **Application.** Use React, TypeScript, and Tailwind for the interface, with a browser 3D renderer for walkthroughs and overhead editing. Store room geometry, objects, placements, constraints, design versions, and cart state in a shared structured model so every view stays consistent.
- **Room capture.** Begin with photos plus user-confirmed measurements. Ordinary photos cannot reliably establish exact scale. A later guided scanning option can use [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/) on supported camera and LiDAR devices. Retain measurement sources and confidence.
- **Product catalog.** Start with curated real products containing merchant links, variants, prices, availability, dimensions, images, and usable 3D assets. Prefer manufacturer models; label approximate representations. Variant changes update dimensions and appearance. Expand retailer search after the complete flow works.
- **Design agent.** Use a multimodal model to interpret photos and preferences, ask questions, search the catalog, and propose structured product and layout changes. Give it tools for budget calculations, spatial checks, and substitutions. Enforce constraints in application code before accepting changes.
- **Spatial validation.** Check object bounds, collisions, door swings, and configurable clearance zones against measured geometry. Use captured outlet and installation information for additional checks. Revalidate after both manual moves and agent edits.
- **Commerce.** Derive the cart from selected product variants. Recheck prices, stock, shipping, and tax before approval. Tie approval to the exact plan; changes require renewed approval unless explicitly authorized. Keep payment credentials outside model context and use the payment provider's supported secure flow.
- **Visa integration.** Confirm sponsor access to [Visa Intelligent Commerce](https://www.visa.com/en-us/solutions/intelligent-commerce) capabilities for credentials, authentication, spending controls, and authorized agent payments. Use available sandbox tools, and label simulated behavior clearly. Do not assume production access.
- **Order handling.** Present one coordinated review while tracking separate merchant orders and payments. Record each outcome, prevent duplicate submissions, and make partial failures explicit. Retry only failed operations without repurchasing successful orders.
- **Persistence and verification.** Save approved designs, purchases, delivery status, and owned items. Verify the demo end to end, especially room/cart consistency, locked choices, budget enforcement, clearance detection, changed-price approval, and duplicate-purchase prevention.

Prioritize verified dimensions, faithful product representations, and a complete purchase journey. Accurate 3D reconstruction of arbitrary internet products is a separate research and catalog challenge beyond the initial demo.

### Agent stack

Use one coordinating agent with typed tools. This is the planned stack; live integrations are not configured yet.

| Layer               | Choice                            | Responsibility                                                                   |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| Runtime             | TypeScript on Convex              | Run agent tools beside the application data and validation logic                 |
| Agent orchestration | Convex Agent                      | Own the agent loop, conversation threads, history, and streaming                 |
| Model access        | Vercel AI SDK                     | Model calls, typed tools, and structured responses                               |
| Model               | GPT-5.6 Terra                     | Interpret the brief, ask questions, compare products, and propose design changes |
| Product discovery   | Exa Search + Contents             | Find product pages and retrieve their content                                    |
| Validation          | Zod and shared TypeScript helpers | Check product data, dimensions, budget, placements, and proposal revisions       |
| Background jobs     | Convex Workflow, when needed      | Durable research and asset jobs with retries                                     |

Confirm the provider's model identifier and access for GPT-5.6 Terra during integration. Keep model configuration separate from the agent's tools and contracts.

Start with `getRoomContext`, `searchProducts`, `getProductDetails`, `checkBudget`, `validatePlacement`, and `proposeDesign`.

1. Read confirmed room geometry, existing furniture, locks, preferences, and budget.
2. Ask for essential missing information.
3. Search the catalog or selected retailers across relevant product categories.
4. Extract specific variants, prices, dimensions, images, and source URLs into `ProductCandidate` records.
5. Filter invalid candidates using application code, then rank the remaining options for the room.
6. Return a structured `DesignProposal` tied to the current room revision.

The model handles aesthetic judgment and tradeoffs. Code enforces arithmetic, collisions, locked objects, and stale-revision checks. Preserve source evidence and unknown fields; search results alone do not verify price, stock, or physical fit.

Begin with Exa's search and content retrieval. Add Firecrawl only if product pages need better extraction. Defer additional agent frameworks, a separate vector database, and specialist agents until a concrete limitation justifies them.

Search developer 1 owns discovery, extraction, deduplication, and product normalization. Search developer 2 owns conversation, tool orchestration, ranking, and proposals. The 3D team owns model acquisition and generation; recommendations should return before model assets finish loading.

References: [Convex Agent](https://docs.convex.dev/agents/overview), [Exa](https://exa.ai/docs/reference/search), [Firecrawl](https://docs.firecrawl.dev/features/scrape), [Convex Workflow](https://www.convex.dev/components/workflow).
