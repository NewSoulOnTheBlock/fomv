import { Buffer } from "buffer";

/**
 * Node globals the browser does not have.
 *
 * Privy's session-signer path encodes key material through `Buffer`, which is
 * a Node global rather than a web one, and Vite ships no Node polyfills by
 * design. Without this, granting delegation fails with "Buffer is not
 * defined" -- from inside library code, so there is no call site to fix.
 *
 * Imported first in `main.tsx`, before anything that might touch it. Assigned
 * only when absent, so a browser or extension that already provides one keeps
 * its own.
 */
const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer; global?: unknown };

if (!g.Buffer) g.Buffer = Buffer;
// Some bundled dependencies still reference `global` rather than `globalThis`.
if (!g.global) g.global = globalThis;
