import {
  LOP_V3_ADDRESS,
  LOP_V4_ADDRESS,
  ORDER_FILLED_V3_TOPIC,
  ORDER_FILLED_V4_TOPIC,
  TRANSFER_TOPIC,
  WETH_WITHDRAWAL_TOPIC,
  ZERO_ADDRESS,
} from "./constants.js";
import type {
  Erc20Transfer,
  FeePayment,
  LopProtocol,
  OrderFill,
  RawLog,
  SrcAttribution,
  TransactionLogs,
} from "./types.js";

interface OrderFilledEvent {
  logIndex: number;
  protocol: LopProtocol;
  router: string;
  orderHash: string;
  remainingAmount: bigint;
  /** Known upfront only for v3, where the event indexes the maker. */
  eventMaker: string | null;
}

interface WethWithdrawal {
  logIndex: number;
  emitter: string;
  src: string;
  wad: bigint;
}

const WORD = 64;

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function dataWord(data: string, index: number): string {
  const body = data.slice(2);
  return body.slice(index * WORD, (index + 1) * WORD);
}

function dataWordCount(data: string): number {
  return Math.floor((data.length - 2) / WORD);
}

function parseTransfers(logs: RawLog[]): Erc20Transfer[] {
  const transfers: Erc20Transfer[] = [];
  for (const log of logs) {
    // ERC-20 Transfer: 3 topics (ERC-721 uses 4) and at least one data word.
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3 || dataWordCount(log.data) < 1) continue;
    const value = BigInt(`0x${dataWord(log.data, 0)}`);
    // Zero-value transfers carry no accounting information — drop them so
    // they can never be picked as a dst/src leg.
    if (value === 0n) continue;
    transfers.push({
      logIndex: log.logIndex,
      token: log.address.toLowerCase(),
      from: topicToAddress(log.topics[1]!),
      to: topicToAddress(log.topics[2]!),
      value,
    });
  }
  return transfers.sort((a, b) => a.logIndex - b.logIndex);
}

function parseOrderFilledEvents(logs: RawLog[]): OrderFilledEvent[] {
  const events: OrderFilledEvent[] = [];
  for (const log of logs) {
    const address = log.address.toLowerCase();
    const topic0 = log.topics[0]?.toLowerCase();
    if (
      address === LOP_V4_ADDRESS &&
      topic0 === ORDER_FILLED_V4_TOPIC &&
      dataWordCount(log.data) >= 2
    ) {
      events.push({
        logIndex: log.logIndex,
        protocol: "lop-v4",
        router: LOP_V4_ADDRESS,
        orderHash: `0x${dataWord(log.data, 0)}`,
        remainingAmount: BigInt(`0x${dataWord(log.data, 1)}`),
        eventMaker: null,
      });
    } else if (
      address === LOP_V3_ADDRESS &&
      topic0 === ORDER_FILLED_V3_TOPIC &&
      log.topics.length === 2 &&
      dataWordCount(log.data) >= 2
    ) {
      events.push({
        logIndex: log.logIndex,
        protocol: "lop-v3",
        router: LOP_V3_ADDRESS,
        orderHash: `0x${dataWord(log.data, 0)}`,
        remainingAmount: BigInt(`0x${dataWord(log.data, 1)}`),
        eventMaker: topicToAddress(log.topics[1]!),
      });
    }
  }
  return events.sort((a, b) => a.logIndex - b.logIndex);
}

function parseWethWithdrawals(logs: RawLog[]): WethWithdrawal[] {
  const withdrawals: WethWithdrawal[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== WETH_WITHDRAWAL_TOPIC) continue;
    if (log.topics.length !== 2 || dataWordCount(log.data) < 1) continue;
    withdrawals.push({
      logIndex: log.logIndex,
      emitter: log.address.toLowerCase(),
      src: topicToAddress(log.topics[1]!),
      wad: BigInt(`0x${dataWord(log.data, 0)}`),
    });
  }
  return withdrawals;
}

/**
 * Reconstructs per-order fill accounting from the logs of a 1inch Fusion
 * (Limit Order Protocol) transaction.
 *
 * Key structural facts this relies on (verified against mainnet batches):
 * - Each fill emits exactly one `OrderFilled` on the LOP router, *after* all
 *   of the fill's token movements. Batches are chained through taker
 *   interactions, so fills NEST (LIFO): the maker-asset transfers of all
 *   orders come first, then sourcing, then the taker-asset transfers and
 *   `OrderFilled` events unwind in reverse order.
 * - The taker-asset (dst) leg is the transfer chain immediately preceding the
 *   fill's `OrderFilled` (never earlier than the previous `OrderFilled`).
 *   With a fee extension as order receiver, the taker pays the extension
 *   gross and the extension splits it (fees + net to the maker) before the
 *   event fires.
 * - The maker-asset (src) leg is found by pairing: the final dst recipient is
 *   normally the same address whose earlier outgoing transfer opened the fill.
 *   For orders with a custom receiver the pairing breaks, and a LIFO pool of
 *   "maker-like" opener transfers is used instead.
 */
export function analyzeTransactionLogs(tx: TransactionLogs): OrderFill[] {
  const txTo = tx.to?.toLowerCase() ?? null;
  const txFrom = tx.from.toLowerCase();

  const transfers = parseTransfers(tx.logs);
  const events = parseOrderFilledEvents(tx.logs);
  const withdrawals = parseWethWithdrawals(tx.logs);

  /** Addresses that emit any log in this tx (pools, tokens, extensions) — never makers. */
  const emitters = new Set(tx.logs.map((log) => log.address.toLowerCase()));

  /** First log index at which an address appears as a transfer recipient. */
  const firstRecipientIndex = new Map<string, number>();
  for (const transfer of transfers) {
    if (!firstRecipientIndex.has(transfer.to)) {
      firstRecipientIndex.set(transfer.to, transfer.logIndex);
    }
  }

  const claimed = new Set<number>();

  const lastUnclaimed = (
    beforeIndex: number,
    afterIndex: number,
    predicate: (t: Erc20Transfer) => boolean,
  ): Erc20Transfer | null => {
    for (let i = transfers.length - 1; i >= 0; i -= 1) {
      const transfer = transfers[i]!;
      if (transfer.logIndex >= beforeIndex) continue;
      if (transfer.logIndex <= afterIndex) break;
      if (claimed.has(transfer.logIndex)) continue;
      if (predicate(transfer)) return transfer;
    }
    return null;
  };

  /**
   * A transfer can open a fill (be the maker-asset leg of some order) when its
   * sender looks like a passive maker wallet: it is not the resolver / tx
   * sender / router / zero address, it emits no logs itself in this tx (pools
   * and extensions do), and it had not received any tokens earlier in the tx
   * (sourcing counterparties get paid within their own swap; makers only send
   * first and receive later).
   */
  const isOpenerEligible = (transfer: Erc20Transfer): boolean => {
    const sender = transfer.from;
    if (sender === ZERO_ADDRESS || sender === txTo || sender === txFrom)
      return false;
    if (sender === LOP_V4_ADDRESS || sender === LOP_V3_ADDRESS) return false;
    if (emitters.has(sender)) return false;
    const receivedAt = firstRecipientIndex.get(sender);
    return receivedAt === undefined || receivedAt >= transfer.logIndex;
  };

  /**
   * The opener pool is the leading run of maker-like transfers at the start
   * of the transaction. Chained (nested) fills pull every order's maker asset
   * up front, before any sourcing swap — and sourcing legs can look
   * deceptively maker-like ("pay-first" market makers), so anything after the
   * first non-opener transfer is out.
   */
  const openerPrefix = new Set<number>();
  for (const transfer of transfers) {
    if (!isOpenerEligible(transfer)) break;
    openerPrefix.add(transfer.logIndex);
  }

  const fills: OrderFill[] = [];
  let prevEventIndex = -1;

  for (const event of events) {
    // --- dst (taker asset) leg -------------------------------------------
    let dst: OrderFill["dst"] = null;

    const candidate = lastUnclaimed(event.logIndex, prevEventIndex, () => true);
    if (candidate) {
      const unwrap =
        candidate.to === event.router
          ? withdrawals.find(
              (w) =>
                w.emitter === candidate.token &&
                w.src === event.router &&
                w.logIndex > candidate.logIndex &&
                w.logIndex < event.logIndex &&
                w.wad === candidate.value,
            )
          : undefined;

      if (unwrap) {
        // Maker asked for native ETH: WETH moved taker -> router, was unwrapped
        // and sent as a plain ETH transfer (no log), so the recipient is unknowable.
        dst = {
          token: "native",
          grossAmount: candidate.value,
          netAmount: candidate.value,
          finalRecipient: null,
          grossSender: candidate.from,
          fees: [],
          logIndex: candidate.logIndex,
        };
        claimed.add(candidate.logIndex);
      } else {
        // 1-hop fee-split detection: `candidate` may be the tail of a
        // gross -> intermediary -> {fees..., net} forwarding chain. The
        // resolver itself holds inventory and is never a transient
        // intermediary, so skip the chain in that case.
        let grouped = false;
        if (candidate.from !== txTo && candidate.from !== txFrom) {
          const inflow = lastUnclaimed(
            candidate.logIndex,
            prevEventIndex,
            (t) => t.to === candidate.from && t.token === candidate.token,
          );
          if (inflow) {
            const between = transfers.filter(
              (t) =>
                t.logIndex > inflow.logIndex &&
                t.logIndex < event.logIndex &&
                !claimed.has(t.logIndex),
            );
            const splits = between.filter(
              (t) => t.from === candidate.from && t.token === candidate.token,
            );
            const splitSum = splits.reduce((acc, t) => acc + t.value, 0n);
            // A genuine fee split is an immediate forwarding: gross inflow,
            // then only the split payments until the OrderFilled event. Any
            // foreign unclaimed transfer in between means `inflow` is some
            // unrelated funding (e.g. another order's maker transfer) and
            // must not be grouped.
            const contiguous = between.length === splits.length;
            if (contiguous && splitSum <= inflow.value && splits.length > 0) {
              let net = splits[0]!;
              for (const split of splits) {
                if (
                  split.value > net.value ||
                  (split.value === net.value && split.logIndex > net.logIndex)
                ) {
                  net = split;
                }
              }
              const fees: FeePayment[] = splits
                .filter((t) => t.logIndex !== net.logIndex)
                .map((t) => ({ recipient: t.to, amount: t.value }));
              dst = {
                token: candidate.token,
                grossAmount: inflow.value,
                netAmount: net.value,
                finalRecipient: net.to,
                grossSender: inflow.from,
                fees,
                logIndex: net.logIndex,
              };
              claimed.add(inflow.logIndex);
              for (const split of splits) claimed.add(split.logIndex);
              grouped = true;
            }
          }
        }
        if (!grouped) {
          dst = {
            token: candidate.token,
            grossAmount: candidate.value,
            netAmount: candidate.value,
            finalRecipient: candidate.to,
            grossSender: candidate.from,
            fees: [],
            logIndex: candidate.logIndex,
          };
          claimed.add(candidate.logIndex);
        }
      }
    }

    // --- src (maker asset) leg -------------------------------------------
    const dstToken = dst && dst.token !== "native" ? dst.token : null;
    const notDstToken = (t: Erc20Transfer): boolean =>
      dstToken === null || t.token !== dstToken;

    let src: Erc20Transfer | null = null;
    let srcAttribution: SrcAttribution = "none";

    const pairKey = event.eventMaker ?? dst?.finalRecipient ?? null;
    if (pairKey) {
      src = lastUnclaimed(
        event.logIndex,
        -1,
        (t) => t.from === pairKey && notDstToken(t),
      );
      if (src) srcAttribution = "paired";
    }
    if (!src) {
      src = lastUnclaimed(
        event.logIndex,
        -1,
        (t) => openerPrefix.has(t.logIndex) && notDstToken(t),
      );
      if (src) srcAttribution = "lifo";
    }
    if (src) claimed.add(src.logIndex);

    fills.push({
      orderHash: event.orderHash,
      protocol: event.protocol,
      orderFilledLogIndex: event.logIndex,
      remainingAmount: event.remainingAmount,
      maker: event.eventMaker ?? src?.from ?? null,
      src: src
        ? { token: src.token, amount: src.value, logIndex: src.logIndex }
        : null,
      dst,
      srcAttribution,
      topLevel: false,
    });

    prevEventIndex = event.logIndex;
  }

  markTopLevelFills(fills, txTo);
  return fills;
}

/**
 * Marks the fills that are the batch's own (Fusion) orders, as opposed to
 * nested sourcing fills (RFQ/LOP orders filled while acquiring the dst asset).
 *
 * Chained batches nest like brackets: each fill's bracket spans from its
 * maker-asset transfer to its OrderFilled event, the batch orders form a
 * sole-child containment chain, and sourcing fills appear as (multiple)
 * sibling brackets inside the innermost batch order. Walk each root's
 * sole-child chain, requiring the taker payment to come from the transaction
 * target (the resolver contract), and stop where the chain fans out.
 */
function markTopLevelFills(fills: OrderFill[], txTo: string | null): void {
  if (fills.length === 1) {
    fills[0]!.topLevel = true;
    return;
  }

  const bracketed = fills.filter((fill) => fill.src !== null);
  const span = (fill: OrderFill): number =>
    fill.orderFilledLogIndex - fill.src!.logIndex;

  const parentOf = new Map<OrderFill, OrderFill | null>();
  for (const fill of bracketed) {
    let parent: OrderFill | null = null;
    for (const other of bracketed) {
      if (other === fill) continue;
      const contains =
        other.src!.logIndex < fill.src!.logIndex &&
        other.orderFilledLogIndex > fill.orderFilledLogIndex;
      if (contains && (parent === null || span(other) < span(parent))) {
        parent = other;
      }
    }
    parentOf.set(fill, parent);
  }

  const childrenOf = (fill: OrderFill): OrderFill[] =>
    bracketed.filter((other) => parentOf.get(other) === fill);

  const paidByResolver = (fill: OrderFill): boolean =>
    fill.dst !== null &&
    fill.dst.grossSender !== null &&
    fill.dst.grossSender === txTo;

  const roots = bracketed.filter((fill) => parentOf.get(fill) === null);
  for (const root of roots) {
    if (!paidByResolver(root)) continue;
    let current = root;
    current.topLevel = true;
    for (;;) {
      const children = childrenOf(current);
      if (children.length !== 1 || !paidByResolver(children[0]!)) break;
      current = children[0]!;
      current.topLevel = true;
    }
  }
}
