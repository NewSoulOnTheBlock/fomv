/**
 * Messages meant for whoever deployed this, not for whoever is reading it.
 *
 * # The mistake this exists to stop
 *
 * A visitor to a trader's page was being told to "re-run `cli.ts profile`".
 * They cannot. They do not have the repository, they are not the operator, and
 * the sentence tells them nothing except that something is broken in a way
 * they are apparently expected to fix. The same text had spread to six other
 * places: environment variable names in a sign-in panel, `bun run` commands in
 * an error state, a Vite variable in a booking step.
 *
 * Every one of those came from the same good instinct -- say exactly what is
 * wrong and exactly what fixes it -- pointed at the wrong reader.
 *
 * So there are two channels. The page says what is *true*, in words that mean
 * something to someone who has never seen the repo. The console says what to
 * *do*, where the only people who will ever look are the people who can act on
 * it. Nothing is lost and nobody is told to run a command they do not have.
 *
 * Deliberately not gated on `import.meta.env.DEV`: the person who most needs
 * this is the one who has just deployed to production and cannot work out why
 * sign-in is missing.
 */

const seen = new Set<string>();

/**
 * Warn the operator once per distinct message.
 *
 * Deduplicated because these fire from render. A component that re-renders on
 * every keystroke would otherwise fill the console with the same line and bury
 * whatever else is in there.
 */
export function operatorHint(area: string, message: string): void {
  const key = `${area}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(`[fomv:${area}] ${message}`);
}
