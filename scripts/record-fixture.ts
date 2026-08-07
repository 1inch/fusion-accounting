/**
 * Records a transaction-receipt fixture for the analyzer tests.
 *
 * Usage: pnpm record-fixture <txHash> <fixtureName> [rpcUrl]
 *
 * Saves the raw receipt fields the analyzer needs (from, to, logs) to
 * test/fixtures/<fixtureName>.json. Values are kept as the hex quantities
 * returned by the RPC so the fixture is a faithful snapshot.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
}

interface RpcReceipt {
  transactionHash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  status: string;
  logs: RpcLog[];
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error) {
    throw new Error(`RPC error: ${body.error.message}`);
  }
  if (body.result === undefined || body.result === null) {
    throw new Error(`RPC returned no result for ${method}`);
  }
  return body.result;
}

async function main(): Promise<void> {
  const [txHash, fixtureName, rpcUrl = DEFAULT_RPC] = process.argv.slice(2);
  if (!txHash || !fixtureName) {
    console.error("Usage: pnpm record-fixture <txHash> <fixtureName> [rpcUrl]");
    process.exit(1);
  }

  const receipt = await rpcCall<RpcReceipt>(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash],
  );
  if (receipt.status !== "0x1") {
    throw new Error(`tx ${txHash} did not succeed (status ${receipt.status})`);
  }

  const fixture = {
    txHash: receipt.transactionHash,
    blockNumber: Number(receipt.blockNumber),
    from: receipt.from,
    to: receipt.to,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: Number(log.logIndex),
    })),
  };

  const outPath = resolve(
    import.meta.dirname,
    "../test/fixtures",
    `${fixtureName}.json`,
  );
  writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${outPath} (${fixture.logs.length} logs)`);
}

await main();
