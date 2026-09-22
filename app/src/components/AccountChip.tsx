import { LogOut } from "lucide-react";

import { CopyAddress } from "@/components/CopyAddress";
import { SignInButton } from "@/components/SignInButton";
import { Lamp } from "@/components/term";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

/**
 * Who you are, in the header.
 *
 * Shows the delegation state rather than only the session, because on this
 * product those are different facts with different consequences. Being signed
 * in means we know who you are; being authorised means a server may sign
 * trades on your wallet. Someone who has granted that should be able to see it
 * from any page without going looking, which is why it is up here and not only
 * on the trader page where it was granted.
 *
 * When nothing is authorised there is no indicator at all. An idle state does
 * not need a label saying it is idle.
 */
export function AccountChip() {
  const auth = useAuth();

  if (!auth.authenticated) return <SignInButton />;

  return (
    <div className="flex items-center gap-3">
      {auth.isDelegated && (
        <Lamp tone="pos" className="hidden sm:inline-flex">
          mirroring
        </Lamp>
      )}

      {auth.walletAddress ? (
        <CopyAddress address={auth.walletAddress} className="hidden sm:inline-flex" />
      ) : (
        <span className="hidden font-mono text-[12px] text-muted-foreground sm:inline">
          wallet pending…
        </span>
      )}

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
