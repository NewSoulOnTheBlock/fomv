import type { DimensionName } from "./types";
import type { EdgeDimension } from "@/components/viz/EdgePentagon";
import { PENTAGON_ORDER } from "@/components/viz/EdgePentagon";

/**
 * The five dimensions, named once.
 *
 * Codes rather than emoji. An emoji in a column of figures is the loudest
 * thing on the page and it is attached to the least quantitative part of it;
 * a three-letter code is legible at 10px inside a polygon vertex, sorts, and
 * renders identically on every machine.
 */
export const DIMENSION_META: Record<DimensionName, { code: string; label: string; blurb: string }> = {
  profitability: {
    code: "PRF",
    label: "Profitability",
    blurb: "Profit factor and the typical trade's return",
  },
  risk: {
    code: "RSK",
    label: "Risk management",
    blurb: "Drawdown, position size, and win-versus-loss size",
  },
  consistency: {
    code: "CNS",
    label: "Consistency",
    blurb: "Stability across time and across tokens",
  },
  exit: {
    code: "EXT",
    label: "Exit skill",
    blurb: "How much of the available move they actually took",
  },
  entry: {
    code: "ENT",
    label: "Entry skill",
    blurb: "Where the token went after they bought",
  },
};

/** Dimensions in pentagon order, ready to plot. Missing input plots as unmeasured. */
export function dimensionsFor(
  dimensions: Partial<Record<DimensionName, number | null>> | undefined,
): EdgeDimension[] {
  return PENTAGON_ORDER.map((key) => ({
    key,
    code: DIMENSION_META[key].code,
    label: DIMENSION_META[key].label,
    value: dimensions?.[key] ?? null,
  }));
}
