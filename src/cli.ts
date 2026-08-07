/**
 * CLI: per-order fill accounting for a 1inch Fusion transaction.
 *
 * Usage:
 *   pnpm analyze <txHash> [--rpc <url>] [--json] [--all]
 *
 *   --rpc   JSON-RPC endpoint (default: https://ethereum-rpc.publicnode.com;
 *           works for any EVM chain where the 1inch routers live at the
 *           canonical addresses)
 *   --json  machine-readable output (amounts as decimal strings)
 *   --all   include nested sourcing fills (RFQ/LOP fills executed while
 *           sourcing liquidity), not only top-level Fusion fills
 */
import { getAddress, isHex } from "viem";
import { analyzeTransactionLogs } from "./analyze.js";
import type { OrderFill, RawLog } from "./types.js";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

interface CliOptions {
  txHash: string;
  rpcUrl: string;
  json: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let txHash: string | null = null;
  let rpcUrl = DEFAULT_RPC;
  let json = false;
  let all = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--rpc") {
      const value = argv[i + 1];
      if (!value) throw new Error("--rpc requires a URL");
      rpcUrl = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--all") {
      all = true;
    } else if (!txHash) {
      txHash = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!txHash || !isHex(txHash) || txHash.length !== 66) {
    throw new Error(
      "usage: pnpm analyze <txHash> [--rpc <url>] [--json] [--all]",
    );
  }
  return { txHash, rpcUrl, json, all };
}

interface RpcReceipt {
  transactionHash: string;
  from: string;
  to: string | null;
  status: string;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
}

async function fetchReceipt(
  rpcUrl: string,
  txHash: string,
): Promise<RpcReceipt> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: RpcReceipt | null;
    error?: { message: string };
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  if (!body.result)
    throw new Error(`transaction ${txHash} not found on ${rpcUrl}`);
  return body.result;
}

function checksum(address: string | null): string {
  if (!address) return "(unknown)";
  if (address === "native") return "native ETH";
  return getAddress(address);
}

function printHuman(fill: OrderFill, index: number): void {
  const lines = [
    `#${index + 1} order ${fill.orderHash}`,
    `    protocol        ${fill.protocol}${fill.topLevel ? "  [top-level Fusion fill]" : "  [nested sourcing fill]"}`,
    `    maker           ${checksum(fill.maker)}${fill.srcAttribution === "lifo" ? "  (via LIFO opener pool)" : ""}`,
    fill.src
      ? `    filled (src)    ${fill.src.amount} of ${checksum(fill.src.token)}`
      : "    filled (src)    (not attributable from logs)",
  ];
  if (fill.dst) {
    lines.push(
      `    dst received    ${fill.dst.netAmount} of ${checksum(fill.dst.token)} -> ${checksum(fill.dst.finalRecipient)}`,
    );
    if (fill.dst.grossAmount !== fill.dst.netAmount) {
      lines.push(
        `    dst gross paid  ${fill.dst.grossAmount} by ${checksum(fill.dst.grossSender)}`,
      );
      for (const fee of fill.dst.fees) {
        lines.push(
          `    fee             ${fee.amount} -> ${checksum(fee.recipient)}`,
        );
      }
    }
  } else {
    lines.push("    dst received    (not attributable from logs)");
  }
  lines.push(
    `    remaining       ${fill.remainingAmount}${fill.remainingAmount === 0n ? " (fully filled)" : ""}`,
  );
  console.log(lines.join("\n"));
}

function toJson(fill: OrderFill): unknown {
  return {
    orderHash: fill.orderHash,
    protocol: fill.protocol,
    topLevel: fill.topLevel,
    maker: fill.maker,
    srcAttribution: fill.srcAttribution,
    src: fill.src
      ? { token: fill.src.token, amount: fill.src.amount.toString() }
      : null,
    dst: fill.dst
      ? {
          token: fill.dst.token,
          grossAmount: fill.dst.grossAmount.toString(),
          netAmount: fill.dst.netAmount.toString(),
          finalRecipient: fill.dst.finalRecipient,
          grossSender: fill.dst.grossSender,
          fees: fill.dst.fees.map((fee) => ({
            recipient: fee.recipient,
            amount: fee.amount.toString(),
          })),
        }
      : null,
    remainingAmount: fill.remainingAmount.toString(),
    orderFilledLogIndex: fill.orderFilledLogIndex,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await fetchReceipt(options.rpcUrl, options.txHash);
  if (receipt.status !== "0x1") {
    throw new Error(
      `transaction ${options.txHash} reverted — nothing was filled`,
    );
  }

  const logs: RawLog[] = receipt.logs.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    logIndex: Number(log.logIndex),
  }));

  const fills = analyzeTransactionLogs({
    txHash: receipt.transactionHash,
    from: receipt.from,
    to: receipt.to,
    logs,
  });
  const selected = options.all ? fills : fills.filter((fill) => fill.topLevel);

  if (options.json) {
    console.log(
      JSON.stringify(
        { txHash: options.txHash, fills: selected.map(toJson) },
        null,
        2,
      ),
    );
    return;
  }

  const nested = fills.length - fills.filter((f) => f.topLevel).length;
  console.log(`tx ${options.txHash}`);
  console.log(
    `${fills.filter((f) => f.topLevel).length} top-level Fusion fill(s), ${nested} nested sourcing fill(s)` +
      (options.all ? "" : " (use --all to show nested fills)"),
  );
  console.log("");
  selected.forEach(printHuman);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
