import { CopyAddress } from "@/components/CopyAddress";
import { TOKEN, tokenExplorerUrl } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * The contract address, copyable.
 *
 * # Why the text is the button
 *
 * The address is shown truncated because forty-four characters do not fit
 * anywhere it needs to go, which makes copying the only way to get it out. A
 * small icon beside unclickable text gives no hint that the text is the thing
 * being copied, and it is a worse target on touch. So the chip copies.
 *
 * Renders nothing while `TOKEN.address` is empty. A contract line showing a
 * placeholder is indistinguishable from a real one until somebody has already
 * sent funds to it.
 */
export function TokenChip({
  size = "md",
  className,
}: {
  /** `sm` for chrome, `md` where it is being read deliberately. */
  size?: "sm" | "md";
  className?: string;
}) {
  const explorer = tokenExplorerUrl();
  if (!TOKEN.address.trim()) return null;

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span className={cn("term-label shrink-0", size === "md" && "!text-[11px]")}>
        ${TOKEN.symbol}
      </span>
      <CopyAddress address={TOKEN.address} lead={size === "md" ? 7 : 6} tail={6} />
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer noopener"
          className="term-label shrink-0 transition-colors hover:text-muted-foreground"
        >
          explorer ↗
        </a>
      )}
    </div>
  );
}
