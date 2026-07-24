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
