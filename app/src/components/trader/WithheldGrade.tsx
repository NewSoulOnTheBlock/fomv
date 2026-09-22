import { Panel, PanelBody, PanelHead } from "@/components/term";
import { cn } from "@/lib/utils";
import type { CoreMetrics } from "@/lib/types";

/**
 * What the page shows when the scorer refused to grade.
 *
 * # Why this exists rather than five empty rows
 *
 * Below twenty complete round trips `buildProfile` short-circuits: no Edge
 * Score, no dimensions, one flag explaining why. That is the right call — a
 * grade computed from eight trades is noise wearing a number — but the page
 * used to render the refusal as the ordinary audit layout with everything
 * hatched. Five rows, each saying "Not measurable from the available data".
 *
 * Repeating a non-answer five times does not read as a deliberate refusal. It
 * reads as broken software, and it buries the one sentence that explains the
 * whole screen at the bottom of the page in a list of caveats. A refusal has
 * to be stated once, first, and with the number that would change it.
 *
 * The figures below this block are left exactly as they are, because they were
 * genuinely measured. Eight round trips is too few to grade a trader on and
 * plenty to report: the win rate is really zero and the loss is really $161.
 * Withholding the score is not the same as having no data, and the page should
 * not conflate them.
 */
export function WithheldGrade({
  core,
  required,
  reason,
  className,
}: {
  core: CoreMetrics;
  /** Closed round trips the scorer needs before it will grade. */
  required: number;
  /** The scorer's own words, when it gave them. */
  reason?: string;
  className?: string;
}) {
  const have = core.closedEpisodes;
  const short = Math.max(0, required - have);
  const segments = required;
  const lit = Math.min(have, required);

  return (
    <Panel className={cn("border-warn/25", className)}>
      <PanelHead
        label="no grade issued"
        aside={`${have} of ${required} round trips`}
        className="border-warn/20"
      />
      <PanelBody className="space-y-5">
        <p className="text-[17px] leading-[1.5]">
          The scorer <span className="text-warn">declined to grade this wallet</span>. It has{" "}
          {have} complete round trip{have === 1 ? "" : "s"}; it needs {required}.
        </p>

        {/* The count, as the thing that has to fill up. Amber because it is a
            progress reading, not a score -- colouring it by band would make
            8-of-20 look like a grade of 40. */}
        <div>
          <div
            className="flex h-2.5 gap-[3px]"
            role="img"
            aria-label={`${have} of ${required} round trips recorded`}
          >
            {Array.from({ length: segments }, (_, i) => (
              <span
                key={i}
                className="flex-1 rounded-full"
                style={{
                  background: i < lit ? "var(--amber)" : "var(--grid)",
                  boxShadow: i === lit - 1 ? "0 0 8px var(--amber)" : undefined,
                }}
              />
            ))}
          </div>
          <div className="term-label mt-2">
            {short} more needed before any dimension is scored
          </div>
        </div>

        <div className="space-y-3.5 border-t border-separator pt-5 text-[14px] leading-relaxed text-muted-foreground">
          <p>
            Every dimension is withheld together rather than a few being scored and the rest left
            blank. A profit factor over eight trades is one good afternoon or one bad one, and a
            partial grade invites exactly the comparison it cannot support — between this wallet
            and one measured over hundreds.
          </p>
          <p>
            <span className="text-foreground">The figures below are still real.</span> They were
            measured from on-chain history the same way as anyone else's; there is simply not
            enough of it to grade. Read them as a description of eight trades, not as a forecast.
          </p>
        </div>

        {reason && (
          <p className="border-t border-separator pt-4 font-mono text-[12px] leading-relaxed text-faint">
            scorer: {reason}
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}
