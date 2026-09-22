import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Minus, Send } from "lucide-react";

import { LISTING_BAR, LISTING_TERMS } from "@engine/platform/listing.js";
import { CalendlyEmbed } from "@/components/apply/CalendlyEmbed";
import { Callout, Panel, PanelBody, PanelHead, SectionRule, Tag } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitApplication } from "@/lib/api";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ApplicationDraft } from "@/lib/types";

/**
 * The trader funnel.
 *
 * # The shape, and why it is this shape
 *
 * Form first, calendar second. Sending a trader straight to a booking link is
 * fewer clicks and loses the two things worth having: the applicants who never
 * book (most of them, and the list actually worth working), and a wallet
 * address that can be fed to `src/cli.ts profile` before the call rather than
 * retyped off a booking confirmation. Turning up to a call with the applicant's
 * audit already run is the entire difference between a sales call and a
 * discovery call.
 *
 * # What the page refuses to do
 *
 * It does not quote a price, because pricing a listing depends on the book in
 * front of us and a number on a public page invites a trader to disqualify
 * themselves before anyone has looked at their history. It does not promise a
 * slot, because the roster is capped and the audit can say no. And it does not
 * pretend the submission succeeded when there is no server to receive it — an
 * unconfigured deployment says so and still offers the calendar, because the
 * call is the thing that matters and the form is the convenience.
 */

const CALENDLY_URL = import.meta.env.VITE_CALENDLY_URL as string | undefined;

const EMPTY_DRAFT: Required<Omit<ApplicationDraft, "elsewhere">> & { elsewhere: string } = {
  handle: "",
  address: "",
  chain: "solana",
  email: "",
  telegram: "",
  twitter: "",
  bookUsd: "",
  strategy: "",
  elsewhere: "",
};

type Phase = "form" | "sent";

export function ApplyPage() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [offline, setOffline] = useState(false);
  const bookingRef = useRef<HTMLDivElement>(null);

  const set = useCallback(
    <K extends keyof typeof EMPTY_DRAFT>(key: K, value: string) =>
      setDraft((d) => ({ ...d, [key]: value })),
    [],
  );

  // Booking is the point of the page, so the step that matters is brought into
  // view rather than left below the fold after a successful submit.
  useEffect(() => {
    if (phase === "sent") bookingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);

    const result = await submitApplication({
      ...draft,
      elsewhere: draft.elsewhere
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });

    setBusy(false);

    if (result.ok) {
      setOffline(false);
      setPhase("sent");
      return;
    }

    // A server that is simply absent must not read as a rejection: the
    // applicant did nothing wrong and should still be sent to the calendar.
    if (result.offline) {
      setOffline(true);
      setErrors(result.errors);
      setPhase("sent");
      return;
    }

    setErrors(result.errors);
  };

  return (
    <div>
      <Masthead />

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start mt-8">
        <div className="min-w-0 space-y-6">
          {phase === "form" ? (
            <Panel>
              <PanelHead label="application" aside="step 1 of 2" />
              <form onSubmit={onSubmit} noValidate>
                <PanelBody className="space-y-5">
                  <Fieldset legend="Identity">
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Field
                        id="handle"
                        label="Handle"
                        hint="What your roster page is titled."
                        value={draft.handle}
                        onChange={(v) => set("handle", v)}
                        placeholder="pointfarmcap"
                        required
                      />
                      <Field
                        id="chain"
                        label="Chain"
                        hint="Only Solana can be mirrored today."
                        value={draft.chain}
                        onChange={(v) => set("chain", v)}
                        readOnly
                      />
                    </div>
                    <Field
                      id="address"
                      label="Wallet to audit"
                      hint="The account whose history gets graded. Not a transaction signature."
                      value={draft.address}
                      onChange={(v) => set("address", v)}
                      placeholder="Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit"
                      mono
                      required
                    />
                    <Field
                      id="elsewhere"
                      label="Other addresses you trade"
                      hint="Optional, comma separated. Recorded rather than dropped — a follower should know when they are getting one chain and not you in full."
                      value={draft.elsewhere}
                      onChange={(v) => set("elsewhere", v)}
                      mono
                    />
                  </Fieldset>

                  <Fieldset legend="Contact" hint="At least one.">
                    <div className="grid sm:grid-cols-3 gap-4">
                      <Field
                        id="email"
                        label="Email"
                        type="email"
                        value={draft.email}
                        onChange={(v) => set("email", v)}
                        placeholder="you@domain.com"
                      />
                      <Field
                        id="telegram"
                        label="Telegram"
                        value={draft.telegram}
                        onChange={(v) => set("telegram", v)}
                        placeholder="@handle"
                      />
                      <Field
                        id="twitter"
                        label="X"
                        value={draft.twitter}
                        onChange={(v) => set("twitter", v)}
                        placeholder="@handle"
                      />
                    </div>
                  </Fieldset>

                  <Fieldset legend="The book">
                    <Field
                      id="bookUsd"
                      label="Roughly what you trade"
                      hint={`In dollars. Self-reported — the audit reads the real figure off chain. Below ${usd(LISTING_BAR.minBookUsd)} there is usually not enough risk taken to measure risk management.`}
                      value={draft.bookUsd}
                      onChange={(v) => set("bookUsd", v)}
                      placeholder="50000"
                      inputMode="decimal"
                    />
                    <div className="space-y-1.5">
                      <Label htmlFor="strategy" className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        What you trade, and why it copies
                      </Label>
                      <Textarea
                        id="strategy"
                        rows={5}
                        required
                        value={draft.strategy}
                        onChange={(e) => set("strategy", e.target.value)}
                        placeholder="Size, holding period, how you pick, what you avoid. If your edge depends on being first by two seconds, say so — a mirrored account is always second and we would rather know now."
                        className="font-sans text-[13px] resize-y"
                      />
                      <p className="text-[11px] leading-snug text-faint">
                        Two or three sentences is plenty. It is read by a person, not scored.
                      </p>
                    </div>
                  </Fieldset>

                  {errors.length > 0 && (
                    <div className="space-y-2" role="alert">
                      {errors.map((e) => (
                        <Callout tone="warn" key={e}>
                          <span className="inline-flex items-start gap-2">
                            <AlertTriangle className="size-3.5 mt-0.5 shrink-0 text-warn" aria-hidden />
                            {e}
                          </span>
                        </Callout>
                      ))}
                    </div>
                  )}
                </PanelBody>

                <div className="border-t border-border p-4 flex flex-wrap items-center gap-4">
                  <Button type="submit" size="lg" className="font-mono" disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <Send />}
                    {busy ? "sending…" : "Submit and pick a time"}
                  </Button>
                  <p className="text-[11px] text-faint flex-1 min-w-[200px]">
                    Submitting opens the calendar. Nothing is charged here and no wallet is
                    connected — this form touches nothing on chain.
                  </p>
                </div>
              </form>
            </Panel>
          ) : (
            <Received offline={offline} notes={errors} handle={draft.handle} />
          )}

          <div ref={bookingRef} className="scroll-mt-24">
            {phase === "sent" && (
              <>
                <SectionRule aside="step 2 of 2">Pick a time</SectionRule>
                {CALENDLY_URL ? (
                  <CalendlyEmbed url={CALENDLY_URL} />
                ) : (
                  <Panel>
                    <PanelHead label="booking not configured" />
                    <PanelBody className="space-y-2">
                      <Callout tone="warn">
                        No calendar is wired up on this deployment. Set{" "}
                        <code className="font-mono">VITE_CALENDLY_URL</code> in{" "}
                        <code className="font-mono">app/.env.local</code> to the Calendly event
                        link.
                      </Callout>
                      <p className="text-[12px] text-muted-foreground">
                        The application above was still recorded.
                      </p>
                    </PanelBody>
                  </Panel>
                )}
              </>
            )}
          </div>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-20">
          <TermsPanel />
          <BarPanel />
        </aside>
      </div>
    </div>
  );
}

function Masthead() {
  return (
    <div className="pt-12 pb-8 border-b border-border">
      <div className="term-label mb-4">for traders · {LISTING_TERMS.maxRoster} seats</div>
      <h1 className="text-3xl sm:text-[38px] leading-[1.08] font-semibold tracking-[-0.03em] max-w-2xl">
        Get audited. Get listed.
        <br />
        Get followed.
      </h1>
      <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground max-w-xl">
        Tell us which wallet to look at and pick a time. Before the call we run the same
        five-dimension audit you can see on any roster page against your real on-chain history, so
        the conversation starts from your numbers rather than your pitch.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Tag tone="accent">solana only, for now</Tag>
        <Tag>you keep your keys</Tag>
        <Tag>you keep trading your own account</Tag>
      </div>
    </div>
  );
}

function Received({
  offline,
  notes,
  handle,
}: {
  offline: boolean;
  notes: string[];
  handle: string;
}) {
  return (
    <Panel>
      <PanelHead
        label={offline ? "not recorded" : "application received"}
        aside={offline ? undefined : <Tag tone="live">logged</Tag>}
      />
      <PanelBody className="space-y-3">
        {offline ? (
          <>
            {notes.map((n) => (
              <Callout tone="warn" key={n}>
                {n}
              </Callout>
            ))}
          </>
        ) : (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Logged{handle ? <> under <span className="font-mono text-foreground">{handle}</span></> : null}. The
            audit runs before the call, so pick a time at least a day out if you can — it needs a
            few hundred RPC reads and a while to price everything.
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}

function TermsPanel() {
  return (
    <Panel>
      <PanelHead label="what a listing is" />
      <div className="divide-y divide-border">
        {LISTING_TERMS.includes.map((line) => (
          <div key={line} className="flex items-start gap-2.5 px-3 py-2.5">
            <Check className="size-3.5 mt-0.5 shrink-0 text-pos" aria-hidden />
            <span className="text-[12px] leading-snug text-secondary-foreground">{line}</span>
          </div>
        ))}
      </div>
      <PanelHead label="what it is not" className="border-t" />
      <div className="divide-y divide-border">
        {LISTING_TERMS.excludes.map((line) => (
          <div key={line} className="flex items-start gap-2.5 px-3 py-2.5">
            <Minus className="size-3.5 mt-0.5 shrink-0 text-faint" aria-hidden />
            <span className="text-[12px] leading-snug text-muted-foreground">{line}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function BarPanel() {
  return (
    <Panel>
      <PanelHead label="the bar" aside="published" />
      <PanelBody className="space-y-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Stated so you can judge before spending half an hour on a call. None of it is enforced by
          the form — a borderline book with a good reason is worth the conversation.
        </p>
        <div className="space-y-2 font-mono text-[12px]">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">closed round trips</span>
            <span>≥ {LISTING_BAR.minClosedTrades}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">book</span>
            <span>≥ {usd(LISTING_BAR.minBookUsd, { compact: true })}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">chain</span>
            <span>{LISTING_BAR.supportedChains.join(", ")}</span>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          Below fifty complete round trips an edge audit measures noise rather than a trader, and
          publishing a grade off it would be dishonest in your favour as often as against you.
        </p>
      </PanelBody>
    </Panel>
  );
}

/* -------------------------------------------------------------- controls -- */

function Fieldset({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-4">
      <legend className="term-rule w-full mb-3">
        <span className="term-label !text-secondary-foreground">{legend}</span>
        {hint && <span className="term-label order-last shrink-0 pl-3">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  mono,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
} & Omit<React.ComponentProps<"input">, "id" | "value" | "onChange">) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
        {rest.required && <span className="text-primary ml-1">*</span>}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          mono ? "font-mono text-[12px]" : "text-[13px]",
          // A field you cannot type in should not invite you to try.
          rest.readOnly && "bg-muted text-muted-foreground focus-visible:ring-0 cursor-default",
        )}
        {...rest}
      />
      {hint && <p className="text-[11px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}
