import { SocialButtons } from "@/components/SocialButtons";
import { TokenChip } from "@/components/TokenChip";
import { SOCIALS, TOKEN, activeSocials } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * The socials and the token, in the footer.
 *
 * Both halves come from the same components the header and the hero use, so
 * there is one definition of each and no way for the address in one place to
 * drift from the address in another. Renders nothing while both are unset.
 */
export function FooterLinks({ className }: { className?: string }) {
  const hasSocials = activeSocials(SOCIALS).length > 0;
  const hasToken = TOKEN.address.trim().length > 0;
  if (!hasSocials && !hasToken) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-6 gap-y-4", className)}>
      <SocialButtons />
      <TokenChip />
    </div>
  );
}
