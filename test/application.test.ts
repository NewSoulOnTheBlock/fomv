import { describe, expect, test } from "bun:test";

import { Store } from "../src/server/store.js";
import { createApplication, meetsBar, validateApplication } from "../src/platform/application.js";
import { LISTING_BAR } from "../src/platform/listing.js";

const T0 = Date.UTC(2026, 0, 1);
const ADDRESS = "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit";

const good = () => ({
  handle: "pointfarmcap",
  address: ADDRESS,
  chain: "solana",
  email: "trader@example.com",
  strategy: "Momentum on new Solana launches, 2-6 hour holds, sized at 3-5% of book per name.",
});

const accepted = (draft: Record<string, unknown>) => {
  const r = validateApplication(draft);
  expect(r.errors).toEqual([]);
  expect(r.value).toBeDefined();
  return r.value!;
};

describe("application validation", () => {
  test("accepts a complete submission", () => {
    const v = accepted(good());
    expect(v.handle).toBe("pointfarmcap");
    expect(v.address).toBe(ADDRESS);
    expect(v.chain).toBe("solana");
  });

  test("reports every problem at once, not the first", () => {
    // A form that reveals one mistake per round trip is the most reliable way
    // to lose an applicant who was willing to pay.
    const r = validateApplication({ handle: "", address: "", strategy: "short" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  test("rejects a signature pasted in place of an account", () => {
    // Base58 but far too long: the single most common paste error, and one
    // that would otherwise reach the audit as an address with no history.
    const r = validateApplication({ ...good(), address: "3".repeat(88) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("Solana address");
  });

  test("requires at least one way to reach the applicant", () => {
    const { email: _drop, ...noContact } = good();
    expect(validateApplication(noContact).ok).toBe(false);

    // Any one of the three is enough.
    expect(validateApplication({ ...noContact, telegram: "@someone" }).ok).toBe(true);
    expect(validateApplication({ ...noContact, twitter: "@someone" }).ok).toBe(true);
  });

  test("strips a leading @ from the X handle", () => {
    const { email: _drop, ...rest } = good();
    expect(accepted({ ...rest, twitter: "@someone" }).twitter).toBe("someone");
  });

  test("records an unsupported chain as an error rather than silently dropping it", () => {
    const r = validateApplication({ ...good(), chain: "base" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("mirrored today");
  });

  test("truncates rather than refusing an over-long strategy", () => {
    // The applicant pasted their whole thesis. That is not a reason to lose
    // the lead; it is a reason to store the first two thousand characters.
    const v = accepted({ ...good(), strategy: "x".repeat(5_000) });
    expect(v.strategy.length).toBe(2_000);
  });

  test("book size is optional and parsed out of a typed dollar figure", () => {
    expect(accepted({ ...good(), bookUsd: "$50,000" }).bookUsd).toBe(50_000);
    expect(accepted({ ...good(), bookUsd: "" }).bookUsd).toBeNull();
  });

  test("caps the extra addresses rather than storing an unbounded list", () => {
    const v = accepted({ ...good(), elsewhere: Array.from({ length: 50 }, (_, i) => `addr${i}`) });
    expect(v.elsewhere.length).toBe(10);
  });
});

describe("the published bar", () => {
  test("is advisory, and never rejects on its own", () => {
    const small = createApplication(accepted({ ...good(), bookUsd: "100" }), T0);
    // Validation passed; only the sort order of the inbox is affected.
    expect(meetsBar(small)).toBe(false);

    const real = createApplication(
      accepted({ ...good(), bookUsd: String(LISTING_BAR.minBookUsd) }),
      T0,
    );
    expect(meetsBar(real)).toBe(true);
  });

  test("an unstated book is not held against the applicant", () => {
    expect(meetsBar(createApplication(accepted(good()), T0))).toBe(true);
  });
});

describe("application persistence", () => {
  test("survives a round trip with its extra addresses intact", () => {
    const s = new Store({ path: ":memory:" });
    const app = createApplication(accepted({ ...good(), elsewhere: ["0xabc", "0xdef"] }), T0);
    s.upsertApplication(app);

    const loaded = s.applicationByAddress(ADDRESS);
    expect(loaded).not.toBeNull();
    expect(loaded!.handle).toBe("pointfarmcap");
    expect(loaded!.elsewhere).toEqual(["0xabc", "0xdef"]);
    expect(loaded!.status).toBe("new");
    s.close();
  });

  test("re-applying updates the answers without creating a second lead", () => {
    const s = new Store({ path: ":memory:" });
    const first = createApplication(accepted(good()), T0);
    s.upsertApplication(first);

    const corrected = createApplication(accepted({ ...good(), handle: "pointfarm" }), T0 + 60_000);
    const stored = s.upsertApplication(corrected);

    expect(s.listApplications().length).toBe(1);
    expect(s.applicationByAddress(ADDRESS)!.handle).toBe("pointfarm");
    // The original id and timestamp survive: a typo correction must not look
    // like a fresh lead, and must not reset the clock on an old one.
    expect(stored.id).toBe(first.id);
    expect(stored.createdAtMs).toBe(T0);
    s.close();
  });

  test("re-applying does not reset a lead that has already had a call", () => {
    const s = new Store({ path: ":memory:" });
    const app = createApplication(accepted(good()), T0);
    s.upsertApplication(app);
    s.setApplicationStatus(app.id, "booked");

    s.upsertApplication(createApplication(accepted({ ...good(), handle: "renamed" }), T0 + 1));

    const loaded = s.applicationByAddress(ADDRESS)!;
    expect(loaded.status).toBe("booked");
    expect(loaded.bookedAtMs).not.toBeNull();
    expect(loaded.handle).toBe("renamed");
    s.close();
  });

  test("counts recent applications, for the endpoint's hourly ceiling", () => {
    const s = new Store({ path: ":memory:" });
    const now = Date.now();
    s.upsertApplication({ ...createApplication(accepted(good()), now), address: "A" });
    s.upsertApplication({ ...createApplication(accepted(good()), now - 7_200_000), address: "B" });

    expect(s.applicationsSince(now - 3_600_000)).toBe(1);
    expect(s.applicationsSince(0)).toBe(2);
    s.close();
  });

  test("lists newest first, which is the order the inbox is worked in", () => {
    const s = new Store({ path: ":memory:" });
    s.upsertApplication({ ...createApplication(accepted(good()), T0), address: "OLD" });
    s.upsertApplication({ ...createApplication(accepted(good()), T0 + 86_400_000), address: "NEW" });

    expect(s.listApplications().map((a) => a.address)).toEqual(["NEW", "OLD"]);
    s.close();
  });
});
