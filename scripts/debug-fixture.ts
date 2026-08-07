/** Debug helper: prints the transfer/OrderFilled structure of a fixture. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTransactionLogs } from "../src/analyze.js";
import {
  LOP_V4_ADDRESS,
  ORDER_FILLED_V4_TOPIC,
  TRANSFER_TOPIC,
} from "../src/constants.js";
import type { RawLog, TransactionLogs } from "../src/types.js";

const name = process.argv[2]!;
const mode = process.argv[3] ?? "fills";
const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../test/fixtures", `${name}.json`),
    "utf8",
  ),
) as TransactionLogs;

const short = (addr: string | null): string =>
  addr ? addr.slice(0, 10) : "null";

if (mode === "logs") {
  for (const log of fixture.logs as RawLog[]) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === TRANSFER_TOPIC && log.topics.length === 3) {
      const from = `0x${log.topics[1]!.slice(-40)}`;
      const to = `0x${log.topics[2]!.slice(-40)}`;
      const value = BigInt(`0x${log.data.slice(2, 66)}`);
      if (value === 0n) continue;
      console.log(
        `${log.logIndex}\tT ${short(log.address)} ${short(from)} -> ${short(to)} ${value}`,
      );
    } else if (
      topic0 === ORDER_FILLED_V4_TOPIC &&
      log.address.toLowerCase() === LOP_V4_ADDRESS
    ) {
      console.log(
        `${log.logIndex}\tOF4 hash=0x${log.data.slice(2, 18)}... rem=${BigInt(`0x${log.data.slice(66, 130)}`)}`,
      );
    }
  }
} else {
  const fills = analyzeTransactionLogs(fixture);
  console.log(`tx.to = ${fixture.to}`);
  for (const fill of fills) {
    console.log(
      `OF@${fill.orderFilledLogIndex} ${fill.orderHash.slice(0, 12)} top=${fill.topLevel} attr=${fill.srcAttribution}\n` +
        `   src: ${fill.src ? `${fill.src.amount} ${short(fill.src.token)} from ${short(fill.maker)} @${fill.src.logIndex}` : "none"}\n` +
        `   dst: ${
          fill.dst
            ? `gross ${fill.dst.grossAmount} net ${fill.dst.netAmount} ${short(fill.dst.token)} -> ${short(fill.dst.finalRecipient)} (grossSender ${short(fill.dst.grossSender)}) fees=${fill.dst.fees.length} @${fill.dst.logIndex}`
            : "none"
        }`,
    );
  }
}
