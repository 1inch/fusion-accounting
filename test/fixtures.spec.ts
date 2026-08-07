import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeTransactionLogs } from "../src/analyze.js";
import type { OrderFill, TransactionLogs } from "../src/types.js";

/**
 * Real-mainnet regression suite.
 *
 * Fixtures are receipts of 1inch Fusion transactions with different batch
 * sizes (1, 2, 3, 4, 6 and 26 orders), recorded via `pnpm record-fixture`.
 * Expected values come from the Dune spellbook table `oneinch.swaps`
 * (see ground-truth.json `__source`): per-fill `making_amount` /
 * `taking_amount` are decoded there from the fill call outputs (traces),
 * which makes them an independent cross-check for this log-based analyzer.
 */

interface GroundTruthFill {
  orderHash: string;
  maker: string;
  receiver: string;
  srcToken: string;
  srcAmountFilled: string;
  dstToken: string;
  dstGross: string;
}

interface GroundTruthEntry {
  txHash: string;
  expectedFills: GroundTruthFill[];
}

const fixturesDir = resolve(import.meta.dirname, "fixtures");

const groundTruth = JSON.parse(
  readFileSync(resolve(fixturesDir, "ground-truth.json"), "utf8"),
) as Record<string, GroundTruthEntry | string>;

/**
 * The Fusion fee extension observed as `order.receiver` in current mainnet
 * flow: it receives the gross taker amount and forwards net-of-fees to the
 * maker within the same fill (before OrderFilled fires).
 */
const FEE_EXTENSION = "0x399740157391a9f1bf4e9921a8834f9bc8f2678e";

function loadFixture(name: string): TransactionLogs {
  return JSON.parse(
    readFileSync(resolve(fixturesDir, `${name}.json`), "utf8"),
  ) as TransactionLogs;
}

function expectedFinalRecipient(fill: GroundTruthFill): string {
  if (fill.receiver === "0x" || fill.receiver === FEE_EXTENSION)
    return fill.maker;
  return fill.receiver;
}

const fixtureNames = Object.keys(groundTruth).filter(
  (key) => !key.startsWith("__"),
);

describe.each(fixtureNames)("%s", (name) => {
  const entry = groundTruth[name] as GroundTruthEntry;
  const fixture = loadFixture(name);
  const fills = analyzeTransactionLogs(fixture);
  const topLevel = fills.filter((fill) => fill.topLevel);

  it(`attributes exactly ${entry.expectedFills.length} top-level Fusion fill(s)`, () => {
    expect(topLevel.length).toBe(entry.expectedFills.length);
  });

  it.each(entry.expectedFills.map((fill) => [fill.orderHash, fill] as const))(
    "order %s: src/dst amounts match the Dune ground truth",
    (_hash, expected) => {
      const matching = fills.filter(
        (fill) => fill.orderHash === expected.orderHash,
      );
      expect(matching.length).toBe(1);
      const fill = matching[0] as OrderFill;

      expect(fill.topLevel).toBe(true);
      expect(fill.protocol).toBe("lop-v4");

      // src leg: how much of the order was filled (maker asset spent).
      expect(fill.src).not.toBeNull();
      expect(fill.src!.token).toBe(expected.srcToken);
      expect(fill.src!.amount).toBe(BigInt(expected.srcAmountFilled));
      expect(fill.maker).toBe(expected.maker);

      // dst leg: what the taker paid and who ended up with it.
      expect(fill.dst).not.toBeNull();
      expect(fill.dst!.token).toBe(expected.dstToken);
      expect(fill.dst!.grossAmount).toBe(BigInt(expected.dstGross));
      expect(fill.dst!.finalRecipient).toBe(expectedFinalRecipient(expected));

      // Conservation: net + fees == gross.
      const feeSum = fill.dst!.fees.reduce((acc, fee) => acc + fee.amount, 0n);
      expect(fill.dst!.netAmount + feeSum).toBe(fill.dst!.grossAmount);
    },
  );
});

describe("orders-2-nested (LIFO nesting + sourcing sub-fills)", () => {
  const fixture = loadFixture("orders-2-nested");
  const fills = analyzeTransactionLogs(fixture);

  it("reports the 3 nested RFQ sourcing fills as non-top-level", () => {
    const nested = fills.filter((fill) => !fill.topLevel);
    expect(nested.map((fill) => fill.orderHash).sort()).toEqual(
      [
        "0xcd396df51fac2a5b8741f81664997936daa17598eedf84a092e8e3bfa1948688",
        "0x63a0388331096e18942d81bb9bb44928fd53d50e52fa4e64d4e18e349d789d6f",
        "0xfd649bb2d29a656eca6bc7407db53282971ff66f1932424b9b8e25ea8b5e4d51",
      ].sort(),
    );
  });

  it("attributes both Fusion fills via receiver pairing", () => {
    for (const fill of fills.filter((f) => f.topLevel)) {
      expect(fill.srcAttribution).toBe("paired");
    }
  });
});

describe("orders-3-custom-receivers (receiver != maker)", () => {
  const fixture = loadFixture("orders-3-custom-receivers");
  const fills = analyzeTransactionLogs(fixture);

  it("falls back to the LIFO opener pool when the dst recipient never sent tokens", () => {
    // All three orders route dst to a custom receiver, so receiver pairing
    // cannot identify the maker; the LIFO opener pool must.
    for (const fill of fills.filter((f) => f.topLevel)) {
      expect(fill.srcAttribution).toBe("lifo");
    }
  });
});

describe("orders-4-fee-split (fee extension as receiver)", () => {
  const fixture = loadFixture("orders-4-fee-split");
  const fills = analyzeTransactionLogs(fixture);

  it("splits gross into net-to-maker plus the 17 + 5 fee payments", () => {
    const topLevel = fills.filter((fill) => fill.topLevel);
    expect(topLevel.length).toBe(4);
    for (const fill of topLevel) {
      expect(fill.dst!.fees.length).toBe(2);
      const feeAmounts = fill
        .dst!.fees.map((fee) => fee.amount)
        .sort((a, b) => (a < b ? -1 : 1));
      expect(feeAmounts).toEqual([5n, 17n]);
      expect(fill.dst!.netAmount).toBe(fill.dst!.grossAmount - 22n);
      const feeRecipients = fill.dst!.fees.map((fee) => fee.recipient).sort();
      expect(feeRecipients).toEqual([
        "0x90cbe4bdd538d6e9b379bff5fe72c3d67a521de5",
        "0xd8df286d10a1f63bbdd29f80e0f5f74205ba8e18",
      ]);
      // The gross amount is paid by the resolver contract (the tx target).
      expect(fill.dst!.grossSender).toBe(fixture.to!.toLowerCase());
    }
  });
});

describe("cross-fixture invariants", () => {
  it.each(fixtureNames)(
    "%s: every fill row has a unique OrderFilled log",
    (name) => {
      const fills = analyzeTransactionLogs(loadFixture(name));
      const logIndexes = fills.map((fill) => fill.orderFilledLogIndex);
      expect(new Set(logIndexes).size).toBe(logIndexes.length);
      for (const fill of fills) {
        if (fill.dst && fill.dst.token !== "native") {
          const feeSum = fill.dst.fees.reduce(
            (acc, fee) => acc + fee.amount,
            0n,
          );
          expect(fill.dst.netAmount + feeSum).toBe(fill.dst.grossAmount);
        }
      }
    },
  );
});
