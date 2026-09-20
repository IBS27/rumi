// The price ceiling decides which shops are worth searching: a $60 lamp and a $2,000
// lamp do not live in exactly the same catalogues. Each tier adds stores to the cheaper
// tiers rather than replacing them: a larger budget should never hide a good IKEA or
// Walmart result. Data, not prose, so the catalogue is testable and easy to maintain.

export type Tier = "value" | "mid" | "luxury";

export interface TierDefinition {
  tier: Tier;
  /** Inclusive upper bound in cents; null for the open-ended top tier. */
  ceilingCents: number | null;
  domains: string[];
}

export const TIERS: TierDefinition[] = [
  {
    tier: "value",
    ceilingCents: 15000,
    domains: [
      "ikea.com",
      "target.com",
      "walmart.com",
      "wayfair.com",
      "homedepot.com",
      "lowes.com",
      "costco.com",
      "worldmarket.com",
      "allmodern.com",
      "jossandmain.com",
      "ashleyfurniture.com",
      "livingspaces.com",
      "roomstogo.com",
      "athome.com",
      "rugsusa.com",
      "ruggable.com",
      "lampsplus.com",
    ],
  },
  {
    tier: "mid",
    // The luxury shops' cheapest case goods start in the thousands.
    ceilingCents: 250000,
    domains: [
      "article.com",
      "westelm.com",
      "cb2.com",
      "burrow.com",
      "floydhome.com",
      "roomandboard.com",
      "crateandbarrel.com",
      "potterybarn.com",
      "joybird.com",
      "apt2b.com",
      "castlery.com",
      "albanypark.com",
      "luluandgeorgia.com",
      "rejuvenation.com",
      "schoolhouse.com",
      "urbanoutfitters.com",
      "polyandbark.com",
      "insideweather.com",
      "sundays-company.com",
      "branchfurniture.com",
      "mcgeeandco.com",
      "sixpenny.com",
    ],
  },
  {
    tier: "luxury",
    ceilingCents: null,
    domains: [
      "dwr.com",
      "rh.com",
      "lumens.com",
      "hay.dk",
      "muuto.com",
      "hermanmiller.com",
      "knoll.com",
      "2modern.com",
      "designpublic.com",
      "finnishdesignshop.com",
    ],
  },
];

export function tierFor(maxPriceCents: number): Tier {
  for (const definition of TIERS)
    if (
      definition.ceilingCents === null ||
      maxPriceCents <= definition.ceilingCents
    )
      return definition.tier;
  return "luxury";
}

export function domainsFor(maxPriceCents: number): string[] {
  const tier = tierFor(maxPriceCents);
  const through = TIERS.findIndex((definition) => definition.tier === tier);
  return [
    ...new Set(
      TIERS.slice(0, through + 1).flatMap((definition) => definition.domains),
    ),
  ];
}
