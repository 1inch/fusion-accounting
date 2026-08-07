import { describe, expect, it } from "vitest";
import { analyzeTransactionLogs } from "../src/analyze.js";
import {
  LOP_V3_ADDRESS,
  LOP_V4_ADDRESS,
  ORDER_FILLED_V3_TOPIC,
  ORDER_FILLED_V4_TOPIC,
  TRANSFER_TOPIC,
  WETH_WITHDRAWAL_TOPIC,
} from "../src/constants.js";
import type { RawLog, TransactionLogs } from "../src/types.js";

/** Synthetic-log unit tests for the attribution engine edge cases. */

const RESOLVER = "0x00000000000000000000000000000000000000aa";
const OPERATOR = "0x00000000000000000000000000000000000000bb";
const MAKER = "0x00000000000000000000000000000000000000c1";
const MAKER_2 = "0x00000000000000000000000000000000000000c2";
const RECEIVER = "0x00000000000000000000000000000000000000d1";
const EXTENSION = "0x00000000000000000000000000000000000000e1";
const FEE_WALLET = "0x00000000000000000000000000000000000000f1";
const POOL = "0x0000000000000000000000000000000000000e0e";
const TOKEN_SRC = "0x0000000000000000000000000000000000000501";
const TOKEN_SRC_2 = "0x0000000000000000000000000000000000000502";
const TOKEN_DST = "0x0000000000000000000000000000000000000601";
const WETH = "0x0000000000000000000000000000000000000777";

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

function pad(value: bigint | string): string {
  const hex =
    typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "");
  return hex.padStart(64, "0");
}

function transfer(
  logIndex: number,
  token: string,
  from: string,
  to: string,
  value: bigint,
): RawLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, `0x${pad(from)}`, `0x${pad(to)}`],
    data: `0x${pad(value)}`,
    logIndex,
  };
}

function erc721Transfer(
  logIndex: number,
  token: string,
  from: string,
  to: string,
  tokenId: bigint,
): RawLog {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      `0x${pad(from)}`,
      `0x${pad(to)}`,
      `0x${pad(tokenId)}`,
    ],
    data: "0x",
    logIndex,
  };
}

function orderFilledV4(
  logIndex: number,
  orderHash: string,
  remaining: bigint,
): RawLog {
  return {
    address: LOP_V4_ADDRESS,
    topics: [ORDER_FILLED_V4_TOPIC],
    data: `0x${pad(orderHash)}${pad(remaining)}`,
    logIndex,
  };
}

function orderFilledV3(
  logIndex: number,
  maker: string,
  orderHash: string,
  remaining: bigint,
): RawLog {
  return {
    address: LOP_V3_ADDRESS,
    topics: [ORDER_FILLED_V3_TOPIC, `0x${pad(maker)}`],
    data: `0x${pad(orderHash)}${pad(remaining)}`,
    logIndex,
  };
}

function wethWithdrawal(logIndex: number, src: string, wad: bigint): RawLog {
  return {
    address: WETH,
    topics: [WETH_WITHDRAWAL_TOPIC, `0x${pad(src)}`],
    data: `0x${pad(wad)}`,
    logIndex,
  };
}

function tx(logs: RawLog[]): TransactionLogs {
  return { from: OPERATOR, to: RESOLVER, logs };
}

describe("analyzeTransactionLogs — synthetic cases", () => {
  it("attributes a plain v4 fill (maker asset out, taker asset in) via pairing", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, TOKEN_DST, RESOLVER, MAKER, 200n),
        orderFilledV4(2, HASH_A, 0n),
      ]),
    );
    expect(fills.length).toBe(1);
    const fill = fills[0]!;
    expect(fill.orderHash).toBe(HASH_A);
    expect(fill.maker).toBe(MAKER);
    expect(fill.src).toEqual({ token: TOKEN_SRC, amount: 100n, logIndex: 0 });
    expect(fill.dst!.grossAmount).toBe(200n);
    expect(fill.dst!.netAmount).toBe(200n);
    expect(fill.dst!.finalRecipient).toBe(MAKER);
    expect(fill.srcAttribution).toBe("paired");
    expect(fill.topLevel).toBe(true);
    expect(fill.remainingAmount).toBe(0n);
  });

  it("groups a 1-hop fee split behind an extension receiver", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, TOKEN_DST, RESOLVER, EXTENSION, 1000n),
        transfer(2, TOKEN_DST, EXTENSION, FEE_WALLET, 30n),
        transfer(3, TOKEN_DST, EXTENSION, MAKER, 970n),
        orderFilledV4(4, HASH_A, 5n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.dst!.grossAmount).toBe(1000n);
    expect(fill.dst!.netAmount).toBe(970n);
    expect(fill.dst!.finalRecipient).toBe(MAKER);
    expect(fill.dst!.fees).toEqual([{ recipient: FEE_WALLET, amount: 30n }]);
    expect(fill.dst!.grossSender).toBe(RESOLVER);
    expect(fill.maker).toBe(MAKER);
    expect(fill.srcAttribution).toBe("paired");
    expect(fill.topLevel).toBe(true);
    expect(fill.remainingAmount).toBe(5n);
  });

  it("rejects a fee-split grouping when outflows exceed the inflow", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        // EXTENSION received only 50 but pays out 200 — its outflow is funded
        // by pre-existing inventory, so it must NOT be grouped as a fee split.
        transfer(1, TOKEN_DST, RESOLVER, EXTENSION, 50n),
        transfer(2, TOKEN_DST, EXTENSION, MAKER, 200n),
        orderFilledV4(3, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.dst!.grossAmount).toBe(200n);
    expect(fill.dst!.netAmount).toBe(200n);
    expect(fill.dst!.finalRecipient).toBe(MAKER);
    expect(fill.dst!.fees).toEqual([]);
  });

  it("never treats the resolver (tx.to) as a fee-split intermediary", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        // Inflow to the resolver followed by the taker payment out of the
        // resolver: must stay a plain dst leg attributed to the resolver.
        transfer(1, TOKEN_DST, POOL, RESOLVER, 10_000n),
        transfer(2, TOKEN_DST, RESOLVER, MAKER, 200n),
        orderFilledV4(3, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.dst!.grossAmount).toBe(200n);
    expect(fill.dst!.grossSender).toBe(RESOLVER);
    expect(fill.dst!.fees).toEqual([]);
    expect(fill.topLevel).toBe(true);
  });

  it("handles nested (LIFO) fills with custom receivers via the opener pool", () => {
    const fills = analyzeTransactionLogs(
      tx([
        // Both makers give their src tokens up front (nested chaining)…
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, TOKEN_SRC_2, MAKER_2, RESOLVER, 111n),
        // …and dst goes to a custom receiver that never sent anything.
        transfer(2, TOKEN_DST, RESOLVER, RECEIVER, 222n),
        orderFilledV4(3, HASH_B, 0n),
        transfer(4, TOKEN_DST, RESOLVER, RECEIVER, 200n),
        orderFilledV4(5, HASH_A, 0n),
      ]),
    );
    expect(fills.length).toBe(2);
    const [fillB, fillA] = fills;
    // LIFO: the innermost fill closed first and owns the latest opener.
    expect(fillB!.orderHash).toBe(HASH_B);
    expect(fillB!.maker).toBe(MAKER_2);
    expect(fillB!.src!.amount).toBe(111n);
    expect(fillB!.srcAttribution).toBe("lifo");
    expect(fillA!.maker).toBe(MAKER);
    expect(fillA!.src!.amount).toBe(100n);
    expect(fillA!.srcAttribution).toBe("lifo");
  });

  it("excludes event-emitting senders (pools) from the opener pool", () => {
    const swapLikeLog: RawLog = {
      address: POOL,
      topics: [`0x${"12".repeat(32)}`],
      data: `0x${pad(1n)}`,
      logIndex: 3,
    };
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        // A V3-style pool pays out before being paid and emits its own event:
        // it must not be mistaken for a maker.
        transfer(1, TOKEN_SRC_2, POOL, RESOLVER, 999n),
        swapLikeLog,
        transfer(4, TOKEN_DST, RESOLVER, RECEIVER, 200n),
        orderFilledV4(5, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.maker).toBe(MAKER);
    expect(fill.src!.amount).toBe(100n);
    expect(fill.srcAttribution).toBe("lifo");
  });

  it("excludes senders that received tokens earlier (swap counterparties) from the opener pool", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        // Sourcing market maker: gets paid first, then pays out.
        transfer(1, TOKEN_SRC_2, RESOLVER, POOL, 500n),
        transfer(2, TOKEN_DST, POOL, RESOLVER, 400n),
        transfer(3, TOKEN_DST, RESOLVER, RECEIVER, 200n),
        orderFilledV4(4, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.maker).toBe(MAKER);
    expect(fill.srcAttribution).toBe("lifo");
  });

  it("detects a WETH unwrap dst leg (native ETH delivery)", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, WETH, RESOLVER, LOP_V4_ADDRESS, 300n),
        wethWithdrawal(2, LOP_V4_ADDRESS, 300n),
        orderFilledV4(3, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.dst!.token).toBe("native");
    expect(fill.dst!.grossAmount).toBe(300n);
    expect(fill.dst!.netAmount).toBe(300n);
    expect(fill.dst!.finalRecipient).toBeNull();
    // ETH send emits no log, so the maker comes from the opener pool.
    expect(fill.maker).toBe(MAKER);
    expect(fill.srcAttribution).toBe("lifo");
    expect(fill.topLevel).toBe(true);
  });

  it("supports v3 OrderFilled events (maker indexed in the event)", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, TOKEN_DST, RESOLVER, MAKER, 200n),
        orderFilledV3(2, MAKER, HASH_A, 40n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.protocol).toBe("lop-v3");
    expect(fill.maker).toBe(MAKER);
    expect(fill.src!.amount).toBe(100n);
    expect(fill.dst!.netAmount).toBe(200n);
    expect(fill.remainingAmount).toBe(40n);
    expect(fill.srcAttribution).toBe("paired");
  });

  it("ignores ERC-721 transfers and zero-value transfers", () => {
    const fills = analyzeTransactionLogs(
      tx([
        transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n),
        transfer(1, TOKEN_DST, RESOLVER, MAKER, 200n),
        erc721Transfer(2, `0x${"71".repeat(20)}`, RESOLVER, MAKER, 1n),
        transfer(3, TOKEN_DST, RESOLVER, RECEIVER, 0n),
        orderFilledV4(4, HASH_A, 0n),
      ]),
    );
    const fill = fills[0]!;
    expect(fill.dst!.token).toBe(TOKEN_DST);
    expect(fill.dst!.netAmount).toBe(200n);
    expect(fill.dst!.finalRecipient).toBe(MAKER);
  });

  it("returns an empty list when the tx contains no OrderFilled events", () => {
    const fills = analyzeTransactionLogs(
      tx([transfer(0, TOKEN_SRC, MAKER, RESOLVER, 100n)]),
    );
    expect(fills).toEqual([]);
  });
});
