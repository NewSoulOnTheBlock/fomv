import { LogOut } from "lucide-react";

import { SignInButton } from "@/components/SignInButton";
import { Tag } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth";
import { shortAddress } from "@/lib/format";

/**
 * Who you are, in the header.
 *
 * Shows the delegation state rather than only the session, because on this
 * product those are different facts with different consequences. Being signed
 * in means we know who you are; being delegated means a server is permitted to
 * sign trades on your wallet. Somebody who has granted that should be able to
 * see it from any page without going looking, which is the whole reason it is
 * up here and not only on the trader page where it was granted.
 */
export function AccountChip() {
  const auth = useAuth();

  if (!auth.authenticated) return <SignInButton />;

  return (
    <div className="flex items-center gap-2">
      {auth.isDelegated ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Tag tone="live">mirroring</Tag>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            FOMV may sign swaps on this wallet. Revoke from any trader's page.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tag className="hidden sm:inline-flex">not following</Tag>
      )}

      <span
        className="hidden sm:inline font-mono text-[12px] text-muted-foreground"
        title={auth.displayName ?? undefined}
      >
        {auth.walletAddress ? shortAddress(auth.walletAddress, 4, 4) : "wallet pending…"}
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={auth.logout}
        aria-label="Sign out"
        title="Sign out"
        className="text-muted-foreground hover:text-foreground"
      >
        <LogOut />
      </Button>
    </div>
  );
}
