use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A USDT amount in the module's smallest on-chain unit (10^-6 USDT,
/// i.e. "micros"). 1 USDT = 1_000_000 micros.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS, Default,
)]
#[ts(export)]
pub struct RpcUsdtAmount(#[ts(type = "number")] pub u64);

/// Credited/claimed/claimable state of a single USDT deposit address owned
/// by this client.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcUsdtDepositStatus {
    /// 0x-prefixed EVM address of the deposit account
    pub address: String,
    /// Total observed+credited by the federation so far
    pub credited: RpcUsdtAmount,
    /// Portion already claimed into e-cash
    pub claimed: RpcUsdtAmount,
    /// credited - claimed; a background claimer turns this into e-cash
    pub claimable: RpcUsdtAmount,
}

/// Status of a USDT withdrawal, identified by the txid returned from
/// `usdtWithdraw`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum RpcUsdtWithdrawalStatus {
    Unknown,
    Queued,
    Signing,
    Submitted,
    #[serde(rename_all = "camelCase")]
    Confirmed {
        #[ts(type = "number")]
        block: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        reason: String,
    },
}

/// Result of generating USDT-denominated e-cash notes (e.g. for an in-chat
/// payment). No Fedi fees are charged on USDT e-cash.
#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcUsdtGenerateEcashResponse {
    pub ecash: String,
    pub operation_id: crate::RpcOperationId,
}

/// One entry of the USDT transaction history, derived from the client
/// operation log (mirroring the usdt-demo-wallet's history feed).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcUsdtTransaction {
    /// Unix seconds
    #[ts(type = "number")]
    pub created_at: u64,
    pub amount: RpcUsdtAmount,
    pub incoming: bool,
    pub kind: RpcUsdtTransactionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum RpcUsdtTransactionKind {
    /// On-chain deposit claimed into e-cash; `address` is the deposit account
    #[serde(rename_all = "camelCase")]
    Deposit { address: String },
    /// On-chain withdrawal; `recipient` is the destination address. `txid`
    /// (when recorded) keys `usdtWithdrawalStatus` for live status.
    #[serde(rename_all = "camelCase")]
    Withdrawal {
        recipient: String,
        #[ts(optional)]
        #[serde(skip_serializing_if = "Option::is_none")]
        txid: Option<String>,
    },
    /// USDT e-cash sent (e.g. in chat)
    EcashSend,
    /// USDT e-cash received (claimed notes / chat payment)
    EcashReceive,
}

/// Federation-side USDT module readiness (whether new deposit addresses can
/// be handed out).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcUsdtStatus {
    pub ready: bool,
    pub healthy_guardians: u16,
    pub threshold: u16,
}
