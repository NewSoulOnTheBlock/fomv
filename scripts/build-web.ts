/**
 * Wrap docs/mandate.html into a standalone HTML document for static hosting.
 *
 * The mandate is authored as an Artifact page, where the host supplies the
 * doctype, <html> and <head>. A plain static host supplies none of that, so
 * publishing the file verbatim ships a headless fragment: no charset, no
 * viewport, no social preview. Generating the standalone copy from the same
 * source keeps the two from drifting.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "docs/mandate.html"), "utf8");

const split = src.indexOf("</style>");
if (split === -1) throw new Error("build-web: could not find </style> in docs/mandate.html");

const head = src.slice(0, split + "</style>".length).trim();
const body = src.slice(split + "</style>".length).trim();

const TITLE = "Mirror Vault Mandate";
const DESCRIPTION =
  "Pooled copy-trading vaults over fomo accounts: weight-based sizing, the guardrail set, and the share ledger.";

// Inline so the page carries its own icon with no extra request or asset host.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<text y="0.9em" font-size="90">⚖️</text></svg>',
  );

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${DESCRIPTION}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#EDEFF3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E1320" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESCRIPTION}">
<link rel="icon" href="${FAVICON}">
${head}
</head>
<body>
${body}
</body>
</html>
`;

mkdirSync(join(root, "web"), { recursive: true });
writeFileSync(join(root, "web/index.html"), html, "utf8");
console.log(`build-web: wrote web/index.html (${(html.length / 1024).toFixed(1)} kB)`);
