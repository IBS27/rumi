// The price ceiling decides which shops are worth searching: a $60 lamp and a $2,000
// lamp do not live in the same catalogues. Data, not prose, so it is testable and easy
// to correct once each domain has been checked against the search provider.

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
      "wayfair.com",
      "amazon.com",
      "walmart.com",
    ],
  },
  {
    tier: "mid",
    ceilingCents: 80000,
    domains: [
      "article.com",
      "westelm.com",
      "cb2.com",
      "burrow.com",
      "floydhome.com",
      "roomandboard.com",
      "crateandbarrel.com",
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
  return TIERS.find((definition) => definition.tier === tier)?.domains ?? [];
}
