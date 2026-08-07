# fusion-accounting

Per-order fill accounting for [1inch Fusion](https://dune.com/1inch/fusion) settlement transactions, reconstructed **from transaction logs alone** (no traces, no calldata decoding, no internal libraries).

Fusion resolvers batch several orders into a single transaction and chain them through taker interactions, so fills **nest** (LIFO): every order's maker asset is pulled up front, sourcing swaps (which may themselves fill RFQ/LOP orders on the same router) happen in the middle, and the taker payments plus `OrderFilled` events unwind in reverse order at the end. This tool untangles that structure and answers, for every order in the batch:

- **how much of the order was filled** — the maker-asset amount that left the maker, and the remaining amount after the fill;
- **how much dst asset was delivered** — gross paid by the resolver, the fee split (protocol / integrator payments made by the fee-extension receiver), the net amount, and who ultimately received it.

## Usage

```bash
pnpm install
pnpm analyze <txHash> [--rpc <url>] [--json] [--all]
```

Example (a 4-order batch with a fee-extension receiver):

```text
$ pnpm analyze 0x4d224b8293f29a8da58306cb0485a07ff0711c7164a93f41d76b0d0120a26486
4 top-level Fusion fill(s), 2 nested sourcing fill(s) (use --all to show nested fills)

#1 order 0xcc0894c75bdc8c057bc4c9427e617d45c3a1fbc0ad5cd16b68d2ee4d5650121b
    protocol        lop-v4  [top-level Fusion fill]
    maker           0x0ada3A19158119f7D5871e3dd335b0634097789C
    filled (src)    36000000 of 0xdAC17F958D2ee523a2206206994597C13D831ec7
    dst received    8837 of 0x68749665FF8D2d112Fa859AA293F07A622782F38 -> 0x0ada3A19158119f7D5871e3dd335b0634097789C
    dst gross paid  8859 by 0xad3b67BCA8935Cb510C8D18bD45F0b94F54A968f
    fee             17 -> 0xd8DF286d10A1f63bBDd29F80E0F5f74205ba8e18
    fee             5 -> 0x90CbE4BDd538D6e9b379bFF5fE72c3d67A521De5
    remaining       0 (fully filled)
...
```

- `--rpc` — any EVM JSON-RPC endpoint (default `https://ethereum-rpc.publicnode.com`). The 1inch routers live at the same canonical addresses on every chain, so the analyzer is chain-agnostic.
- `--json` — machine-readable output; all amounts are decimal strings (the library API uses `bigint` end to end — no floats anywhere).
- `--all` — also print nested sourcing fills (RFQ/LOP orders the resolver filled while acquiring the dst asset).

Library API:

```ts
import { analyzeTransactionLogs } from "./src/index.js";

const fills = analyzeTransactionLogs({ from, to, logs }); // OrderFill[]
```

## How it works

The engine walks the receipt's `OrderFilled` events (LOP v4 `OrderFilled(bytes32 orderHash, uint256 remainingAmount)` on the router `0x111111125421ca6dc452d289314280a0f8842a65`; LOP v3 supported best-effort) in log order, claiming ERC-20 `Transfer` logs so no transfer is attributed twice:

1. **dst (taker asset) leg** — the nearest unclaimed transfer before the event, never reaching past the previous `OrderFilled` (LOP emits the event right after the taker payment). If that transfer is the tail of an _immediate_ forwarding chain — gross paid to the order's receiver extension, which then pays out fees and the remainder with no foreign transfer in between — the whole group is claimed: gross, fee payments, and net to the final recipient. A `WETH` transfer into the router followed by a matching `Withdrawal` is recognized as a native-ETH delivery (the final ETH send emits no log, so the recipient is reported as unknown).
2. **src (maker asset) leg** — found by **pairing**: the final dst recipient is normally the maker, whose earlier outgoing transfer opened the fill. When the order pays out to a custom receiver (pairing impossible), the engine falls back to a **LIFO pool of opener transfers**: the leading run of transfers at the start of the tx whose senders look like passive maker wallets (they emit no logs, and had received nothing earlier in the tx). Nested fills close in reverse order of their openers, so popping the latest unclaimed opener reproduces the chaining exactly.
3. **top-level vs sourcing fills** — batch orders form a sole-child bracket-containment chain (each fill's bracket spans maker transfer → `OrderFilled`), while sourcing fills show up as sibling brackets inside the innermost batch order. The engine walks each root's sole-child chain, requiring the taker payment to come from the transaction target (the resolver contract), and marks those fills `topLevel`.

## Validation

`pnpm test` runs two suites (72 assertions):

- **Real-mainnet fixtures** with batch sizes **1, 2, 3, 4, 6 and 26 orders** (`test/fixtures/*.json`, recorded via `pnpm record-fixture <txHash> <name>`), including nested LIFO batches with RFQ sub-fills, fee-extension receivers (gross/net/fee split), custom EOA receivers, and a batch where one maker has three different orders. Expected per-order amounts come from the Dune spellbook table `oneinch.swaps` (`mode = 'fusion'`), where `making_amount` / `taking_amount` are decoded from the fill call outputs (traces) — an independent source against which the log-based reconstruction must agree exactly. See [ground-truth.json](test/fixtures/ground-truth.json) (Dune query [8253529](https://dune.com/queries/8253529); batch discovery query [8253355](https://dune.com/queries/8253355), built the same way the [1inch Fusion dashboard's _Batches_ section](https://dune.com/1inch/fusion) counts orders per tx).
- **Synthetic unit tests** for the engine's edge cases: fee-split grouping and its guards (non-contiguous groups, outflows exceeding the inflow, the resolver never being an intermediary), opener-pool eligibility (event-emitting senders, pay-later counterparties, zero address), WETH unwrap, LOP v3 events, ERC-721 and zero-value transfer filtering.

## Guarantees & known limitations

Everything is reconstructed from logs, so some things are heuristic by nature:

- **Native-ETH deliveries** (`Withdrawal` path) report the unwrapped amount but not the recipient — plain ETH sends emit no logs. If a fee extension splits native ETH, only the gross amount is visible.
- **`topLevel` is a structural heuristic.** A "fusion order" is not distinguishable from any other LOP order by logs alone (that difference lives in calldata extensions); the bracket-chain rule classifies all six fixture transactions correctly, but exotic resolver flows could confuse it. Per-order amounts are unaffected — every `OrderFilled` is reported either way.
- **Custom-receiver orders whose maker transfer is not part of the opening run** (e.g. a resolver that swaps before pulling the maker asset in a sequential, non-chained fill) fall back to `srcAttribution: 'none'` rather than guessing.
- **LOP v3 (Fusion v1, 2022–2024)** fills are decoded from the maker-indexed v3 event and attributed with the same engine, but no real v3 batch fixture is included (current v3 traffic is dust/self-fill spam), so treat v3 output as best-effort.
- Fee-on-transfer / rebasing tokens report what the `Transfer` events state, which for such tokens may differ from balance deltas.
