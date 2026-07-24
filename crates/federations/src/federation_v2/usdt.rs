//! USDT (USDT-on-EVM module) support for [`FederationV2`].
//!
//! The USDT balance itself is USDT-denominated e-cash held in a second
//! `mintv2` instance (`fedimint_usdt_common::USDT_UNIT`); the usdt module
//! handles on-chain deposits (per-user ERC-4337 deposit accounts) and
//! withdrawals (federation-MPC-signed UserOps). Payment UX is deliberately
//! Bitcoin-like: receive = hand out a deposit address, send = pay to an EVM
//! address. There is no BTC<->USDT exchange functionality here.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use fedimint_core::db::IDatabaseTransactionOpsCoreTyped;
use fedimint_core::task::sleep;
use fedimint_core::{OutPoint, TransactionId};
use fedimint_usdt_client::db::{ClaimKeyKey, ClaimKeyPrefixAll};
use fedimint_usdt_common::{BootstrapState, EvmAddress, USDT_UNIT, UsdtAmount, WithdrawalStatus};
use futures::StreamExt;
use rpc_types::event::{Event, UsdtDepositEvent, UsdtDepositState, UsdtWithdrawalEvent};
use rpc_types::usdt::{
    RpcUsdtAmount, RpcUsdtDepositStatus, RpcUsdtStatus, RpcUsdtWithdrawalStatus,
};
use rpc_types::event::TypedEventExt as _;
use tracing::{info, instrument, warn};

use super::FederationV2;
use super::client::ClientExt as _;

/// How long a freshly generated deposit address is actively watched for an
/// incoming on-chain deposit before the background watcher gives up (the
/// startup sweep and `usdtCheckDeposits` still pick it up later).
const DEPOSIT_WATCH_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

/// How long we poll a submitted withdrawal for on-chain confirmation.
const WITHDRAWAL_WATCH_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

impl FederationV2 {
    /// Whether the joined federation runs the usdt module.
    pub fn usdt_supported(&self) -> bool {
        self.client.usdt().is_ok()
    }

    /// The unit this federation's mintv2 instance denominates e-cash in,
    /// `None` if the federation has no mintv2 module.
    pub fn ecash_unit(&self) -> Option<rpc_types::RpcEcashUnit> {
        let unit = self.client.mintv2().ok()?.amount_unit();
        Some(if unit == fedimint_core::module::AmountUnit::BITCOIN {
            rpc_types::RpcEcashUnit::Bitcoin
        } else if unit == USDT_UNIT {
            rpc_types::RpcEcashUnit::Usdt
        } else {
            rpc_types::RpcEcashUnit::Other
        })
    }

    /// USDT e-cash balance in 10^-6 USDT units.
    pub async fn usdt_balance(&self) -> Result<RpcUsdtAmount> {
        if self.recovering() {
            return Ok(RpcUsdtAmount(0));
        }
        // USDT-denominated e-cash lives in the USDT-unit mintv2 instance; the
        // custom-unit Amount carries raw 10^-6 USDT units in its msat field.
        let balance = self.client.get_balance_for_unit(USDT_UNIT).await?;
        Ok(RpcUsdtAmount(balance.msats))
    }

    /// Federation-side module readiness (gates handing out new deposit
    /// addresses).
    pub async fn usdt_status(&self) -> Result<RpcUsdtStatus> {
        let usdt = self.client.usdt()?;
        let status = usdt.status().await?;
        Ok(RpcUsdtStatus {
            ready: status.state == BootstrapState::Ready,
            healthy_guardians: status.healthy_guardians,
            threshold: status.threshold,
        })
    }

    /// Allocates a fresh deposit address and spawns a background watcher that
    /// claims the deposit into USDT e-cash once the federation credits it.
    pub async fn usdt_generate_deposit_address(&self) -> Result<String> {
        let usdt = self.client.usdt()?;
        let (_keypair, address) = usdt.allocate_deposit().await?;
        self.spawn_usdt_deposit_watcher(address, DEPOSIT_WATCH_DEADLINE);
        Ok(address.to_string())
    }

    /// Credited/claimed/claimable state of one of our deposit addresses.
    pub async fn usdt_deposit_status(&self, address: String) -> Result<RpcUsdtDepositStatus> {
        let usdt = self.client.usdt()?;
        let address = EvmAddress::from_str(&address)?;
        let keypair = usdt
            .db
            .clone()
            .begin_transaction_nc()
            .await
            .get_value(&ClaimKeyKey(address))
            .await
            .ok_or_else(|| anyhow!("unknown deposit address {address}"))?;
        let status = usdt.deposit_status(keypair.public_key()).await?;
        Ok(RpcUsdtDepositStatus {
            address: status.account.to_string(),
            credited: RpcUsdtAmount(status.credited.0),
            claimed: RpcUsdtAmount(status.claimed.0),
            claimable: RpcUsdtAmount(status.claimable.0),
        })
    }

    /// All deposit addresses this client has ever allocated, with their
    /// current status (newest-index last).
    pub async fn usdt_list_deposits(&self) -> Result<Vec<RpcUsdtDepositStatus>> {
        let usdt = self.client.usdt()?;
        let keypairs: Vec<_> = usdt
            .db
            .clone()
            .begin_transaction_nc()
            .await
            .find_by_prefix(&ClaimKeyPrefixAll)
            .await
            .collect()
            .await;

        let mut deposits = Vec::with_capacity(keypairs.len());
        for (ClaimKeyKey(address), keypair) in keypairs {
            match usdt.deposit_status(keypair.public_key()).await {
                Ok(status) => deposits.push(RpcUsdtDepositStatus {
                    address: status.account.to_string(),
                    credited: RpcUsdtAmount(status.credited.0),
                    claimed: RpcUsdtAmount(status.claimed.0),
                    claimable: RpcUsdtAmount(status.claimable.0),
                }),
                Err(err) => {
                    warn!(%address, ?err, "failed to fetch usdt deposit status");
                }
            }
        }
        Ok(deposits)
    }

    /// One-shot pass over all known deposit addresses: claims anything
    /// claimable right now. Returns the number of deposits claimed.
    pub async fn usdt_check_deposits(&self) -> Result<u32> {
        let usdt = self.client.usdt()?;
        let keypairs: Vec<_> = usdt
            .db
            .clone()
            .begin_transaction_nc()
            .await
            .find_by_prefix(&ClaimKeyPrefixAll)
            .await
            .collect()
            .await;

        let mut claimed = 0u32;
        for (ClaimKeyKey(address), keypair) in keypairs {
            let claim_pk = keypair.public_key();
            let Ok(status) = usdt.deposit_status(claim_pk).await else {
                continue;
            };
            if status.claimable.0 == 0 {
                continue;
            }
            match usdt.claim(claim_pk).await {
                Ok(result) => {
                    claimed += 1;
                    self.emit_usdt_deposit_claimed(address, result.claimed);
                }
                Err(err) => {
                    warn!(%address, ?err, "failed to claim usdt deposit");
                }
            }
        }
        Ok(claimed)
    }

    /// Seed-only gap-limit rescan for deposits made by a previous device /
    /// before a restore, followed by a claim pass.
    pub async fn usdt_recover_deposits(&self) -> Result<u32> {
        let usdt = self.client.usdt()?;
        let summary = usdt.recover_deposits(20).await?;
        info!(?summary, "usdt deposit recovery finished");
        self.usdt_check_deposits().await
    }

    /// Quote for the on-chain fee of withdrawing `amount` right now, in
    /// 10^-6 USDT units. The fee is deducted from the withdrawn amount by
    /// the federation.
    pub async fn usdt_withdraw_fee_quote(&self, amount: RpcUsdtAmount) -> Result<RpcUsdtAmount> {
        let usdt = self.client.usdt()?;
        let quote = usdt.withdraw_fee_quote(UsdtAmount(amount.0)).await?;
        Ok(RpcUsdtAmount(quote.max_fee.0))
    }

    /// Withdraws `amount` (10^-6 USDT units) of USDT e-cash to an on-chain
    /// EVM address. Returns the txid identifying the withdrawal; progress is
    /// reported via `UsdtWithdrawal` events and `usdtWithdrawalStatus`.
    pub async fn usdt_withdraw(
        &self,
        recipient: String,
        amount: RpcUsdtAmount,
        max_fee: RpcUsdtAmount,
    ) -> Result<String> {
        let usdt = self.client.usdt()?;
        let recipient = EvmAddress::from_str(&recipient).context("invalid recipient address")?;
        if amount.0 == 0 {
            bail!("withdrawal amount must be positive");
        }

        let range = usdt
            .withdraw(recipient, UsdtAmount(amount.0), UsdtAmount(max_fee.0))
            .await?;
        let txid = range.txid();

        self.runtime
            .event_sink
            .typed_event(&Event::UsdtWithdrawal(UsdtWithdrawalEvent {
                federation_id: self.rpc_federation_id(),
                txid: txid.to_string(),
                state: RpcUsdtWithdrawalStatus::Queued,
            }));

        self.spawn_usdt_withdrawal_watcher(txid);

        Ok(txid.to_string())
    }

    /// Current status of a withdrawal previously initiated with
    /// [`Self::usdt_withdraw`].
    pub async fn usdt_withdrawal_status(&self, txid: String) -> Result<RpcUsdtWithdrawalStatus> {
        let usdt = self.client.usdt()?;
        let txid = TransactionId::from_str(&txid).context("invalid txid")?;
        let status = usdt
            .withdrawal_status(OutPoint { txid, out_idx: 0 })
            .await?;
        Ok(convert_withdrawal_status(status.status))
    }

    /// Startup pass: claim anything already claimable for our known deposit
    /// addresses (covers deposits that landed while the app was closed).
    pub(super) fn spawn_usdt_startup_claimer(&self) {
        if !self.usdt_supported() {
            return;
        }
        self.spawn_cancellable("usdt_startup_claimer", move |fed| async move {
            match fed.usdt_check_deposits().await {
                Ok(0) => {}
                Ok(n) => info!(claimed = n, "usdt startup claimer claimed deposits"),
                Err(err) => warn!(?err, "usdt startup claimer failed"),
            }
        });
    }

    /// Watches a single deposit address until a deposit is claimed or the
    /// deadline passes.
    #[instrument(skip(self))]
    fn spawn_usdt_deposit_watcher(&self, address: EvmAddress, deadline: Duration) {
        self.spawn_cancellable("usdt_deposit_watcher", move |fed| async move {
            if let Err(err) = fed.watch_usdt_deposit(address, deadline).await {
                warn!(%address, ?err, "usdt deposit watcher failed");
                fed.runtime
                    .event_sink
                    .typed_event(&Event::UsdtDeposit(UsdtDepositEvent {
                        federation_id: fed.rpc_federation_id(),
                        address: address.to_string(),
                        state: UsdtDepositState::Failed {
                            reason: format!("{err:#}"),
                        },
                    }));
            }
        });
    }

    async fn watch_usdt_deposit(&self, address: EvmAddress, deadline: Duration) -> Result<()> {
        let usdt = self.client.usdt()?;
        let keypair = usdt
            .db
            .clone()
            .begin_transaction_nc()
            .await
            .get_value(&ClaimKeyKey(address))
            .await
            .ok_or_else(|| anyhow!("unknown deposit address {address}"))?;
        let claim_pk = keypair.public_key();

        // Ask the federation to start watching the address on-chain.
        usdt.check_deposit(claim_pk).await?;

        let deadline_at = fedimint_core::time::now() + deadline;
        let mut backoff = Duration::from_secs(2);
        loop {
            let status = usdt.deposit_status(claim_pk).await?;
            if status.claimable.0 > 0 {
                let result = usdt.claim(claim_pk).await?;
                self.emit_usdt_deposit_claimed(address, result.claimed);
                return Ok(());
            }
            if fedimint_core::time::now() >= deadline_at {
                // Not an error: the address stays valid; the startup claimer /
                // usdtCheckDeposits will claim a later deposit.
                info!(%address, "usdt deposit watcher deadline passed without a deposit");
                return Ok(());
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    fn emit_usdt_deposit_claimed(&self, address: EvmAddress, amount: UsdtAmount) {
        self.runtime
            .event_sink
            .typed_event(&Event::UsdtDeposit(UsdtDepositEvent {
                federation_id: self.rpc_federation_id(),
                address: address.to_string(),
                state: UsdtDepositState::Claimed {
                    amount: RpcUsdtAmount(amount.0),
                },
            }));
    }

    fn spawn_usdt_withdrawal_watcher(&self, txid: TransactionId) {
        self.spawn_cancellable("usdt_withdrawal_watcher", move |fed| async move {
            let out_point = OutPoint { txid, out_idx: 0 };
            let Ok(usdt) = fed.client.usdt() else {
                return;
            };
            let deadline_at = fedimint_core::time::now() + WITHDRAWAL_WATCH_DEADLINE;
            let mut backoff = Duration::from_secs(2);
            let mut last_reported = RpcUsdtWithdrawalStatus::Queued;
            loop {
                match usdt.withdrawal_status(out_point).await {
                    Ok(status) => {
                        let rpc_status = convert_withdrawal_status(status.status);
                        let terminal = matches!(
                            rpc_status,
                            RpcUsdtWithdrawalStatus::Confirmed { .. }
                                | RpcUsdtWithdrawalStatus::Failed { .. }
                        );
                        if !variant_eq(&rpc_status, &last_reported) {
                            fed.runtime.event_sink.typed_event(&Event::UsdtWithdrawal(
                                UsdtWithdrawalEvent {
                                    federation_id: fed.rpc_federation_id(),
                                    txid: txid.to_string(),
                                    state: rpc_status.clone(),
                                },
                            ));
                            last_reported = rpc_status;
                        }
                        if terminal {
                            return;
                        }
                    }
                    Err(err) => {
                        warn!(%txid, ?err, "usdt withdrawal status poll failed");
                    }
                }
                if fedimint_core::time::now() >= deadline_at {
                    warn!(%txid, "usdt withdrawal watcher deadline passed");
                    return;
                }
                sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        });
    }
}

fn convert_withdrawal_status(status: WithdrawalStatus) -> RpcUsdtWithdrawalStatus {
    match status {
        WithdrawalStatus::Unknown => RpcUsdtWithdrawalStatus::Unknown,
        WithdrawalStatus::Queued => RpcUsdtWithdrawalStatus::Queued,
        WithdrawalStatus::Signing { .. } => RpcUsdtWithdrawalStatus::Signing,
        WithdrawalStatus::Submitted { .. } => RpcUsdtWithdrawalStatus::Submitted,
        WithdrawalStatus::Confirmed { block } => RpcUsdtWithdrawalStatus::Confirmed { block },
        WithdrawalStatus::Failed { reason } => RpcUsdtWithdrawalStatus::Failed { reason },
    }
}

fn variant_eq(a: &RpcUsdtWithdrawalStatus, b: &RpcUsdtWithdrawalStatus) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}
