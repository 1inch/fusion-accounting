/** A raw EVM log as returned by eth_getTransactionReceipt (hex fields untouched). */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

/** The slice of a transaction receipt the analyzer needs. */
export interface TransactionLogs {
  txHash?: string;
  /** Transaction sender (EOA that signed). */
  from: string;
  /** Transaction target — for Fusion fills this is the resolver contract. */
  to: string | null;
  logs: RawLog[];
}

/** A decoded ERC-20 Transfer event. */
export interface Erc20Transfer {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export type LopProtocol = "lop-v4" | "lop-v3";

export interface FeePayment {
  recipient: string;
  amount: bigint;
}

/** How the src (maker) leg was attributed. */
export type SrcAttribution =
  /** Found by pairing: the final dst recipient previously sent this transfer. */
  | "paired"
  /** Found via the LIFO pool of maker-like opener transfers (custom receiver orders). */
  | "lifo"
  /** Could not be attributed from logs. */
  | "none";

/** Accounting for one OrderFilled event. */
export interface OrderFill {
  orderHash: string;
  protocol: LopProtocol;
  orderFilledLogIndex: number;
  /** Remaining making amount after this fill (0 = fully filled). */
  remainingAmount: bigint;
  /** The order maker: src.from when attributed; for v3 decoded from the event itself. */
  maker: string | null;
  /** Maker-side leg: what left the maker for this fill. */
  src: {
    token: string;
    amount: bigint;
    logIndex: number;
  } | null;
  /** Taker-side leg: what was delivered for this fill. */
  dst: {
    /** ERC-20 token address, or 'native' when the taker asset was unwrapped WETH. */
    token: string;
    /** Amount paid by the taker side (before any fee split). */
    grossAmount: bigint;
    /** Amount delivered to the final recipient (gross minus fees). */
    netAmount: bigint;
    /**
     * Who ultimately received the net amount. For orders with the default
     * receiver this is the maker; for fee-extension orders the extension
     * forwards the net here; null for native-ETH delivery (ETH sends emit no logs).
     */
    finalRecipient: string | null;
    /** Who paid the gross amount (the taker; tx.to for top-level Fusion fills). */
    grossSender: string | null;
    fees: FeePayment[];
    logIndex: number;
  } | null;
  srcAttribution: SrcAttribution;
  /**
   * Heuristic: true when the gross dst amount was paid by the transaction
   * target (the resolver contract) — i.e. this is a top-level Fusion fill
   * rather than a nested sourcing (RFQ/LOP) fill.
   */
  topLevel: boolean;
}
