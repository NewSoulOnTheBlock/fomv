import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { SignInButton } from "./components/SignInButton";
import { FollowPanel } from "./components/FollowPanel";
import { useAuth } from "./lib/auth";
import type { AppData, RosterEntry, TraderProfile } from "./lib/types";
import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { bps, pct, relative, score, shortAddress, usd } from "./lib/format";
import { bandOf } from "./lib/format";

export function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("data/app.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app.json: ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="shell">
      <Header />
      {error && (
        <div className="banner">
          <strong>No data.</strong> {error} — run <code>bun run build:appdata</code> in the repo root
          to generate it.
        </div>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (selected ? (
        <VaultView data={data} leader={selected} onBack={() => setSelected(null)} />
      ) : (
        <RosterView data={data} onOpen={setSelected} />
      ))}
      <Footer />
    </div>
  );
}

function Header() {
  const auth = useAuth();

  return (
    <header className="top">
      <div className="brand">
        <span className="mark">FOMV</span>
        <span className="sub">Fear of Missing Vault</span>
      </div>
      <div className="who">
        {auth.authenticated ? (
          <>
            <span className="small muted">{auth.displayName}</span>
            {auth.walletAddress && (
              <span className="addr small">{shortAddress(auth.walletAddress, 4, 4)}</span>
            )}
            <button onClick={auth.logout}>Sign out</button>
          </>
        ) : (
          <SignInButton />
        )}
      </div>
    </header>
  );
}


function RosterView({ data, onOpen }: { data: AppData; onOpen: (leader: string) => void }) {
  const [profiles, setProfiles] = useState<Record<string, TraderProfile>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      data.roster.map(async (r) => {
        try {
          const res = await fetch(`data/profiles/${r.leader}.json`);
          return res.ok ? ([r.leader, (await res.json()) as TraderProfile] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setProfiles(Object.fromEntries(rows.filter((x): x is readonly [string, TraderProfile] => x !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>The roster</h2>
      <p className="muted small" style={{ marginTop: "-0.5rem" }}>
        Follow a curated trader with your own wallet. Their swaps are mirrored into your account by
        portfolio weight — FOMV never holds your funds and cannot move them.
      </p>

      <div className="grid" style={{ marginTop: "1rem" }}>
        {data.roster.map((r) => (
          <VaultCard key={r.leader} entry={r} profile={profiles[r.leader]} onOpen={() => onOpen(r.leader)} />
        ))}
        {data.roster.length === 0 && <p className="muted">No traders listed yet.</p>}
      </div>
    </div>
  );
}

function VaultCard({
  entry,
  profile,
  onOpen,
}: {
  entry: RosterEntry;
  profile: TraderProfile | undefined;
  onOpen: () => void;
}) {
  const edge = profile?.profile.edgeScore ?? null;
  const band = bandOf(edge);
  return (
    <button className="card vault-card" onClick={onOpen}>
      <div className="top">
        <span className="handle">{entry.handle}</span>
        <span className={`pill ${entry.status}`}>{entry.status}</span>
      </div>
      <div className="stats">
        <div>
          <div className="k">Edge score</div>
          <div className="v" style={{ color: edge === null ? "var(--text-faint)" : `var(--${band})` }}>
            {score(edge)}
          </div>
        </div>
        <div>
          <div className="k">Realized P&L</div>
          <div className="v">{usd(profile?.profile.core.realizedPnlUsd ?? null, { compact: true })}</div>
        </div>
        <div>
          <div className="k">Max drawdown</div>
          <div className="v">{pct(profile?.profile.core.maxDrawdown ?? null)}</div>
        </div>
        <div>
          <div className="k">Trade fee</div>
          <div className="v">{bps(DEFAULT_FEE_TERMS.tradeFeeBps)}</div>
        </div>
      </div>
      {entry.note && (
        <p className="small faint" style={{ marginTop: "0.8rem", marginBottom: 0 }}>
          {entry.note}
        </p>
      )}
    </button>
  );
}

function VaultView({ data, leader, onBack }: { data: AppData; leader: string; onBack: () => void }) {
  const entry = data.roster.find((r) => r.leader === leader);
  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProfile(null);
    setMissing(false);
    fetch(`data/profiles/${leader}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then(setProfile)
      .catch(() => setMissing(true));
  }, [leader]);

  if (!entry) return <p className="muted">Unknown vault.</p>;

  return (
    <div>
      <button className="backlink" onClick={onBack}>
        ← All vaults
      </button>

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>{entry.handle}</h3>
          <p className="mono small faint" style={{ marginTop: "-0.4rem" }}>
            {entry.leader}
          </p>
          <div className="grid cols-2" style={{ marginTop: "1rem" }}>
            <div>
              <div className="faint small">Custody</div>
              <div className="mono">self</div>
            </div>
            <div>
              <div className="faint small">Deposit / withdrawal fee</div>
              <div className="mono">none</div>
            </div>
          </div>
          {entry.elsewhere?.map((e) => (
            <div className="callout gap" key={e.address}>
              <span className="mono small">{shortAddress(e.address, 6, 6)}</span> — {e.note}
            </div>
          ))}
          {profile && (
            <p className="small faint" style={{ marginBottom: 0 }}>
              Metrics refreshed {relative(profile.provenance.computedAtMs)}.
            </p>
          )}
        </div>

        <FollowPanel vault={entry} />
      </div>

      {profile && <Dashboard data={profile} />}
      {missing && (
        <div className="banner" style={{ marginTop: "1.5rem" }}>
          <strong>No profile yet.</strong> Run{" "}
          <code>bun run src/cli.ts profile --candidates {shortAddress(leader, 6, 6)}</code> then
          rebuild the app data.
        </div>
      )}
      {!profile && !missing && <p className="muted" style={{ marginTop: "1.5rem" }}>Loading metrics…</p>}
    </div>
  );
}

function Footer() {
  return (
    <div className="footer">
      Copy-trading replicates another account's transactions at the operator's sole direction. This
      is not investment advice. Operating a pooled vehicle that takes other people's money is a
      regulated activity in most jurisdictions.
    </div>
  );
}
