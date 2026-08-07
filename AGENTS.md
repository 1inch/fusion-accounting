# AGENTS.md

TypeScript tool that reconstructs per-order fill accounting for 1inch Fusion
transactions from receipt logs. Public npm dependencies only (`viem`, `vitest`,
`tsx`, `typescript`) — do **not** add private `@1inch/*` packages; that is an
explicit constraint of this repo. Always use **pnpm**.

- Install: `pnpm install` (public registry, no auth needed).
- Checks: `pnpm lint:types` (tsc strict) and `pnpm test` (vitest; offline —
  fixture receipts are committed under `test/fixtures/`).
- Run: `pnpm analyze <txHash> [--rpc <url>] [--json] [--all]` — needs network
  access to a public JSON-RPC endpoint (default `ethereum-rpc.publicnode.com`).
- Record a new fixture: `pnpm record-fixture <txHash> <name> [rpcUrl]`, then
  add the expected per-order rows to `test/fixtures/ground-truth.json`
  (source them from the Dune `oneinch.swaps` spellbook — `complement`
  `making_amount`/`taking_amount` per fill, see the `__source` note there).
- The attribution engine in `src/analyze.ts` is invariant-heavy (claim
  discipline, opener prefix, bracket containment). Change it only together
  with the real-mainnet fixture suite; `test/fixtures.spec.ts` must stay green
  without loosening the exact-`bigint` amount assertions.
