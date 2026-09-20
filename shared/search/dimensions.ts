import type { Category, Dimensions } from "../contracts";

export type Unit = "in" | "ft" | "cm" | "mm" | "m";
export type Axis = "width" | "height" | "depth";

const TO_METERS: Record<Unit, number> = {
  in: 0.0254,
  ft: 0.3048,
  cm: 0.01,
  mm: 0.001,
  m: 1,
};

// A single measurement, in its printed unit. Diagram reads produce many of these.
export interface AxisReading {
  value: number;
  unit: Unit | null;
  axis: Axis | "unknown";
  subject: "overall" | "component" | "unknown";
  label: string;
}

export interface AxisValues {
  width: number | null;
  height: number | null;
  depth: number | null;
}

export interface Reading {
  values: AxisValues;
  detail: string | null;
  issue: string | null;
}

const AXES: Axis[] = ["width", "height", "depth"];
const EMPTY: AxisValues = { width: null, height: null, depth: null };

// Ranges a real product of each category falls inside, in meters. Used both to reject
// an implausible reading and to resolve a measurement printed without its unit.
export const PLAUSIBLE_RANGES: Record<
  string,
  Record<Axis, [number, number]>
> = {
  bed: { width: [0.7, 2.2], height: [0.2, 1.6], depth: [1.6, 2.3] },
  desk: { width: [0.6, 2.4], height: [0.6, 1.3], depth: [0.4, 0.9] },
  lighting: { width: [0.05, 1.2], height: [0.1, 2.5], depth: [0.05, 1.2] },
  rug: { width: [0.4, 4], height: [0.002, 0.1], depth: [0.6, 5] },
  storage: { width: [0.3, 3], height: [0.2, 2.6], depth: [0.2, 0.8] },
  art: { width: [0.1, 2.5], height: [0.1, 2.5], depth: [0.01, 0.15] },
  curtain: { width: [0.4, 6], height: [0.6, 3.5], depth: [0.01, 0.3] },
  textile: { width: [0.2, 3], height: [0.02, 0.5], depth: [0.2, 3] },
};

// Unknown categories stay usable without pretending we know category-specific bounds.
// This catches only physically implausible readings; fit is still enforced by the task.
const GENERIC_RANGE: Record<Axis, [number, number]> = {
  width: [0.01, 10],
  height: [0.001, 10],
  depth: [0.01, 10],
};

export function axisInRange(
  category: Category,
  axis: Axis,
  meters: number,
): boolean {
  const [low, high] = (PLAUSIBLE_RANGES[familyOf(category)] ?? GENERIC_RANGE)[axis];
  return meters >= low && meters <= high;
}

export function withinRange(
  category: Category,
  dimensions: Dimensions,
): boolean {
  return AXES.every((axis) => axisInRange(category, axis, dimensions[axis]));
}

export function completeDimensions(values: AxisValues): Dimensions | null {
  if (values.width === null || values.height === null || values.depth === null)
    return null;
  return { width: values.width, height: values.height, depth: values.depth };
}

const round = (meters: number) => Math.round(meters * 1000) / 1000;

function readingOf(
  values: AxisValues,
  detail: string | null,
  issue: string | null,
): Reading {
  return { values, detail, issue };
}

// --- Text ------------------------------------------------------------------

const UNIT_WORDS: Record<string, Unit> = {
  '"': "in",
  "''": "in",
  in: "in",
  "in.": "in",
  inch: "in",
  inches: "in",
  ft: "ft",
  "ft.": "ft",
  foot: "ft",
  feet: "ft",
  "'": "ft",
  cm: "cm",
  mm: "mm",
  m: "m",
};

const AXIS_WORDS: Record<
  string,
  Axis | "diameter" | "length" | "pile" | "thickness"
> = {
  w: "width",
  width: "width",
  d: "depth",
  depth: "depth",
  h: "height",
  height: "height",
  // A round piece states its diameter, which is its width and its depth at once.
  dia: "diameter",
  diam: "diameter",
  diameter: "diameter",
  ø: "diameter",
  // Rugs and beds state width by length; elsewhere "length" is too ambiguous to use.
  l: "length",
  length: "length",
  // A rug's height is its pile; a print's depth is its frame.
  pile: "pile",
  "pile height": "pile",
  thickness: "thickness",
  thick: "thickness",
  "frame depth": "depth",
  profile: "thickness",
};

// The planner names categories freely ("area rug", "wall mirror", "blackout
// curtain panels"). Dimension conventions follow the family, not the wording.
export function familyOf(category: Category): Category {
  const value = category.toLowerCase();
  if (/\brug\b|carpet|runner/.test(value)) return "rug";
  if (/curtain|drape/.test(value)) return "curtain";
  if (/pillow|cushion|throw\b|blanket/.test(value)) return "textile";
  if (/\bart\b|artwork|painting|poster|print|canvas|mirror|tapestry/.test(value))
    return "art";
  if (/\bbed\b|mattress/.test(value)) return "bed";
  if (/desk/.test(value)) return "desk";
  if (/lamp|light|pendant|chandelier|sconce/.test(value)) return "lighting";
  if (/wardrobe|dresser|cabinet|bookcase|shelf|shelving|storage|console|credenza|nightstand/.test(value))
    return "storage";
  return value;
}

const LENGTH_IS_DEPTH: Category[] = ["rug", "bed"];

function axesFor(word: string, category: Category): Axis[] {
  const family = familyOf(category);
  const mapped = AXIS_WORDS[word.toLowerCase().replace(/\s+/g, " ")];
  if (!mapped) return [];
  if (mapped === "diameter") return ["width", "depth"];
  if (mapped === "length")
    return LENGTH_IS_DEPTH.includes(family) ? ["depth"] : [];
  if (mapped === "pile") return family === "rug" ? ["height"] : [];
  if (mapped === "thickness")
    return family === "rug"
      ? ["height"]
      : family === "art" || family === "curtain"
        ? ["depth"]
        : [];
  return [mapped];
}

// Flat categories state their size as a pair by convention: a rug lies on the
// floor (width × length), art and curtains hang (width × height). The third
// axis is a thin, known constant filled in by completeFlat.
const PAIR_AXES: Record<string, [Axis, Axis]> = {
  rug: ["width", "depth"],
  art: ["width", "height"],
  curtain: ["width", "height"],
  textile: ["width", "depth"],
};

// The axis a flat piece's listing leaves out, and the value to assume, in meters.
const FLAT_THIRD_AXIS: Record<string, { axis: Axis; meters: number }> = {
  rug: { axis: "height", meters: 0.01 },
  art: { axis: "depth", meters: 0.03 },
  curtain: { axis: "depth", meters: 0.05 },
  // A pillow or folded throw lies on a surface about a hand deep.
  textile: { axis: "height", meters: 0.15 },
};

// A rug listed as 5' × 8' is complete: nobody prints its thickness. Fill the
// thin axis for flat families when the two real axes are present.
export function completeFlat(values: AxisValues, category: Category): AxisValues {
  const flat = FLAT_THIRD_AXIS[familyOf(category)];
  if (!flat || values[flat.axis] !== null) return values;
  const others = AXES.filter((axis) => axis !== flat.axis);
  if (others.some((axis) => values[axis] === null)) return values;
  return { ...values, [flat.axis]: flat.meters };
}

const UNIT_PATTERN =
  `(?:inches|inch|in\\.|in|feet|foot|ft\\.|ft|cm|mm|m|''|"|')` as const;
const NUMBER = String.raw`\d+(?:\.\d+)?`;

// Packaging is larger than the product, so a shipping line poisons a reading. Filter
// menus advertise ranges and result counts, which read like measurements and are not.
const EXCLUDED_LINE =
  /(package|packag|shipping|carton|box dimensions|freight|\(\d+\)|\bto\b\s*\d+\s*(?:"|in\b|cm\b))/i;

function toUnit(raw: string | undefined): Unit | null {
  if (!raw) return null;
  return UNIT_WORDS[raw.toLowerCase().trim()] ?? null;
}

// US retail prints fractions: 31 1/2" is one number, and 1/2" is another.
function normalizeFractions(text: string): string {
  return text
    .replace(
      /(\d+)\s+(\d+)\/(\d+)/g,
      (match, whole: string, numerator: string, denominator: string) =>
        Number(denominator) === 0
          ? match
          : String(Number(whole) + Number(numerator) / Number(denominator)),
    )
    .replace(
      /(?<![\d.])(\d+)\/(\d+)(?![\d.])/g,
      (match, numerator: string, denominator: string) =>
        Number(denominator) === 0 || Number(denominator) > 64
          ? match
          : String(Number(numerator) / Number(denominator)),
    );
}

// "5'3"" is one measurement, not two. Rewrite it before anything else looks.
function normalizeFeetInches(text: string): string {
  return normalizeFractions(text).replace(
    new RegExp(String.raw`(\d+)\s*'\s*(${NUMBER})\s*"`, "g"),
    (_match, feet: string, inches: string) =>
      `${Number(feet) * 12 + Number(inches)} in`,
  );
}

interface TextMatch {
  axis: Axis;
  value: number;
  unit: Unit | null;
  label: string;
}

const AXIS_PATTERN =
  "(?:pile height|frame depth|width|depth|height|diameter|diam|dia|length|thickness|thick|profile|pile|W|D|H|L|ø)";

function collectLabelled(line: string, category: Category): TextMatch[] {
  const found: TextMatch[] = [];
  // 63"W  |  63 in W  |  160 cm Width
  const suffix = new RegExp(
    String.raw`(${NUMBER})[ \t]*(${UNIT_PATTERN})?[ \t]*\(?(${AXIS_PATTERN})\)?(?![a-z])`,
    "g",
  );
  for (const match of line.matchAll(suffix))
    for (const axis of axesFor(match[3], category))
      found.push({
        axis,
        value: Number(match[1]),
        unit: toUnit(match[2]),
        label: match[0].trim(),
      });
  // Width: 160 cm  |  W = 63 in  |  Diameter: 6"
  const prefix = new RegExp(
    String.raw`(?:^|[^a-z])(${AXIS_PATTERN})\b[ \t]*[:=]?[ \t]*(${NUMBER})[ \t]*(${UNIT_PATTERN})?`,
    "gi",
  );
  for (const match of line.matchAll(prefix))
    for (const axis of axesFor(match[1], category))
      found.push({
        axis,
        value: Number(match[2]),
        unit: toUnit(match[3]),
        label: match[0].trim(),
      });
  return found;
}

// "W x D x H: 160 x 48 x 180 cm". A positional triple is only usable when the page
// states its own axis order.
function collectPositional(line: string, category: Category): TextMatch[] {
  const order = line.match(
    /(?:^|[^a-z])(w|d|h|l)[ \t]*[x×][ \t]*(w|d|h|l)[ \t]*[x×][ \t]*(w|d|h|l)(?![a-z])/i,
  );
  const triple = line.match(
    new RegExp(
      String.raw`(${NUMBER})[ \t]*[x×][ \t]*(${NUMBER})[ \t]*[x×][ \t]*(${NUMBER})[ \t]*(${UNIT_PATTERN})?`,
    ),
  );
  if (!triple) return [];
  if (!order) return [{ axis: "width", value: NaN, unit: null, label: "" }];
  const unit = toUnit(triple[4]);
  const found: TextMatch[] = [];
  for (let index = 0; index < 3; index++)
    for (const axis of axesFor(order[index + 1], category))
      found.push({
        axis,
        value: Number(triple[index + 1]),
        unit,
        label: `${triple[index + 1]}${unit ? ` ${unit}` : ""}`,
      });
  return found;
}

// "2.5' x 8'" for a rug, "16\" x 23\"" for a print. Only a pair, never part of a triple.
function collectPair(line: string, category: Category): TextMatch[] {
  const axes = PAIR_AXES[familyOf(category)];
  if (!axes) return [];
  const pair = line.match(
    new RegExp(
      String.raw`(?<![\d.])(${NUMBER})[ \t]*(${UNIT_PATTERN})?[ \t]*[x×][ \t]*(${NUMBER})[ \t]*(${UNIT_PATTERN})?(?![ \t]*[x×])`,
      "i",
    ),
  );
  if (!pair) return [];
  const second = toUnit(pair[4]);
  const first = toUnit(pair[2]) ?? second;
  return [
    {
      axis: axes[0],
      value: Number(pair[1]),
      unit: first,
      label: pair[0].trim(),
    },
    { axis: axes[1], value: Number(pair[3]), unit: second ?? first, label: "" },
  ];
}

// A measurement printed without its unit is resolved by asking which unit puts every
// axis inside the plausible range. Exactly one answer means the unit is known.
function inferUnit(matches: TextMatch[], category: Category): Unit | null {
  const candidates: Unit[] = ["in", "cm", "mm", "m", "ft"];
  const valid = candidates.filter((unit) =>
    matches.every((match) =>
      axisInRange(category, match.axis, match.value * TO_METERS[unit]),
    ),
  );
  return valid.length === 1 ? valid[0] : null;
}

function axesIn(matches: TextMatch[]): number {
  return new Set(matches.map((match) => match.axis)).size;
}

type Attempt =
  | { kind: "complete"; reading: Reading }
  | { kind: "partial"; reading: Reading }
  | { kind: "rejected"; issue: string };

function attempt(matches: TextMatch[], category: Category): Attempt {
  const unitless = matches.filter((match) => match.unit === null);
  const inferred =
    unitless.length === matches.length ? inferUnit(matches, category) : null;
  if (unitless.length === matches.length && inferred === null)
    return { kind: "rejected", issue: "The measurements carry no unit." };
  const values: AxisValues = { ...EMPTY };
  const labels: string[] = [];
  for (const match of matches) {
    const unit = match.unit ?? inferred;
    if (!unit) continue;
    if (values[match.axis] !== null) continue; // first mention wins
    values[match.axis] = round(match.value * TO_METERS[unit]);
    if (match.label)
      labels.push(match.unit ? match.label : `${match.label} (${unit})`);
  }
  const filled = completeFlat(values, category);
  const complete = completeDimensions(filled);
  if (complete && !withinRange(category, complete))
    return {
      kind: "rejected",
      issue: `The page dimensions are outside the plausible range for a ${category}.`,
    };
  const reading = readingOf(filled, labels.join(" x ") || null, null);
  return { kind: complete ? "complete" : "partial", reading };
}

export function parseDimensionText(text: string, category: Category): Reading {
  const lines = normalizeFeetInches(text)
    .split(/[\n\r;]+/)
    .filter((line) => !EXCLUDED_LINE.test(line));
  const whole: TextMatch[][] = [];
  const pairs: TextMatch[][] = [];
  const scattered: TextMatch[] = [];
  let sawUnorderedTriple = false;
  for (const line of lines) {
    const labelled = collectLabelled(line, category);
    if (labelled.length > 0) {
      if (axesIn(labelled) === 3) whole.push(labelled);
      else scattered.push(...labelled);
      continue;
    }
    const positional = collectPositional(line, category);
    if (positional.length === 1 && Number.isNaN(positional[0].value)) {
      sawUnorderedTriple = true;
      continue;
    }
    if (positional.length > 0) {
      whole.push(positional);
      continue;
    }
    const pair = collectPair(line, category);
    if (pair.length > 0) pairs.push(pair);
  }
  // A whole statement first, then a conventional pair completed by whatever the page
  // says elsewhere, then measurements scattered through the page. A statement that
  // fails the plausible range is a shipping box or a part; the next one is tried.
  const groups: TextMatch[][] = [
    ...whole,
    ...pairs.map((pair) => [...pair, ...scattered]),
    scattered,
  ].filter((group) => group.length > 0);
  if (groups.length === 0)
    return readingOf(
      EMPTY,
      null,
      sawUnorderedTriple
        ? "The page states dimensions without an axis order."
        : "No measurements were printed in the page text.",
    );
  let partial: Reading | null = null;
  let rejection: string | null = null;
  for (const group of groups) {
    const result = attempt(group, category);
    if (result.kind === "complete") return result.reading;
    if (result.kind === "partial" && !partial) partial = result.reading;
    if (result.kind === "rejected" && !rejection) rejection = result.issue;
  }
  if (partial) return partial;
  return readingOf(
    EMPTY,
    null,
    rejection ?? "No measurements were printed in the page text.",
  );
}

// --- Diagram ---------------------------------------------------------------

// The overall size on an axis is the largest measurement on that axis: a part cannot
// exceed the whole. This holds even when the model mislabels which is which.
export function selectOverall(
  readings: AxisReading[],
  category: Category,
): Reading {
  const usable = readings.filter(
    (item) => item.axis !== "unknown" && item.unit !== null && item.value > 0,
  );
  if (usable.length === 0)
    return readingOf(EMPTY, null, "The image printed no usable measurements.");

  const values: AxisValues = { ...EMPTY };
  const labels: string[] = [];
  for (const axis of AXES) {
    const onAxis = usable.filter((item) => item.axis === axis);
    if (onAxis.length === 0) continue;
    const meters = onAxis.map((item) => item.value * TO_METERS[item.unit!]);
    const largest = Math.max(...meters);
    const declared = onAxis
      .filter((item) => item.subject === "overall")
      .map((item) => item.value * TO_METERS[item.unit!]);
    // Two overall readings far apart mean the image shows two product sizes.
    if (declared.some((value) => value < largest * 0.85))
      return readingOf(
        EMPTY,
        null,
        `The image appears to show two ${category} sizes, so its measurements are ambiguous.`,
      );
    values[axis] = round(largest);
    labels.push(onAxis[meters.indexOf(largest)].label);
  }
  const complete = completeDimensions(values);
  if (!complete)
    return readingOf(values, labels.join(" x ") || null, "An axis is missing.");
  if (!withinRange(category, complete))
    return readingOf(
      EMPTY,
      null,
      `The image dimensions are outside the plausible range for a ${category}.`,
    );
  return readingOf(values, labels.join(" x "), null);
}

// --- Merging ---------------------------------------------------------------

// The page text is authoritative. A diagram may only fill axes the text left empty,
// and only when it agrees with the text everywhere the text spoke.
export function mergeReadings(
  text: Reading,
  image: Reading,
  tolerance = 0.1,
): Reading {
  const shared = AXES.filter(
    (axis) => text.values[axis] !== null && image.values[axis] !== null,
  );
  for (const axis of shared) {
    const fromText = text.values[axis] as number;
    const fromImage = image.values[axis] as number;
    if (
      Math.abs(fromText - fromImage) / Math.max(fromText, fromImage) >
      tolerance
    )
      return readingOf(
        text.values,
        text.detail,
        `The diagram disagrees with the page text on ${axis}.`,
      );
  }
  const values: AxisValues = { ...text.values };
  const labels: string[] = [];
  for (const axis of AXES) {
    if (values[axis] === null && image.values[axis] !== null) {
      values[axis] = image.values[axis];
      labels.push(axis);
    }
  }
  if (labels.length === 0) return text;
  const detail = [text.detail, image.detail].filter(Boolean).join(" + ");
  return readingOf(values, detail || null, null);
}
