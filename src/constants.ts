/** 1inch Aggregation Router V6 = Limit Order Protocol v4 (same address on all chains). */
export const LOP_V4_ADDRESS = "0x111111125421ca6dc452d289314280a0f8842a65";

/** 1inch Aggregation Router V5 = Limit Order Protocol v3 (Fusion v1 era). */
export const LOP_V3_ADDRESS = "0x1111111254eeb25477b68fb85ed929f73a960582";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** keccak256("OrderFilled(bytes32,uint256)") — LOP v4. */
export const ORDER_FILLED_V4_TOPIC =
  "0xfec331350fce78ba658e082a71da20ac9f8d798a99b3c79681c8440cbfe77e07";

/** keccak256("OrderFilled(address,bytes32,uint256)") — LOP v3, maker indexed. */
export const ORDER_FILLED_V3_TOPIC =
  "0xb9ed0243fdf00f0545c63a0af8850c090d86bb46682baec4bf3c496814fe4f02";

/** keccak256("Withdrawal(address,uint256)") — WETH9 unwrap. */
export const WETH_WITHDRAWAL_TOPIC =
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
