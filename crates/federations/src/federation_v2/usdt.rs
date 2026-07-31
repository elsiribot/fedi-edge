//! USDT (USDT-on-EVM module) support for [`FederationV2`].
//!
//! The USDT balance itself is USDT-denominated e-cash held in a second
//! `mintv2` instance (`fedimint_usdt_common::USDT_UNIT`); the usdt module
//! handles on-chain deposits (per-user ERC-4337 deposit accounts) and
//! withdrawals (federation-MPC-signed UserOps). Payment UX is deliberately
//! Bitcoin-like: receive = hand out a deposit address, send = pay to an EVM
//! address. There is no BTC<->USDT exchange functionality here.

use std::str::FromStr;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use fedimint_client::db::ChronologicalOperationLogKey;
use fedimint_core::base32::{FEDIMINT_PREFIX, decode_prefixed};
use fedimint_core::core::OperationId;
use fedimint_core::db::IDatabaseTransactionOpsCoreTyped;
use fedimint_core::secp256k1::{Keypair, PublicKey};
use fedimint_core::task::sleep;
use fedimint_core::{OutPoint, TransactionId};
use fedimint_mintv2_client::{
    ECash as MintV2ECash, FinalReceiveOperationState as MintV2FinalReceiveOperationState,
    MintOperationMeta as MintV2OperationMeta,
};
use fedimint_usdt_client::UsdtOperationMeta;
use fedimint_usdt_client::db::{ClaimKeyKey, ClaimKeyPrefixAll};
use fedimint_usdt_client::evm::{DEFAULT_EVM_RPC_URLS, EthJsonRpc};
use fedimint_usdt_common::{BootstrapState, EvmAddress, USDT_UNIT, UsdtAmount, WithdrawalStatus};
use futures::StreamExt;
use rpc_types::error::ErrorCode;
use rpc_types::event::{
    Event, TypedEventExt as _, UsdtDepositEvent, UsdtDepositState, UsdtWithdrawalEvent,
};
use rpc_types::usdt::{
    RpcUsdtAmount, RpcUsdtDepositStatus, RpcUsdtGenerateEcashResponse, RpcUsdtStatus,
    RpcUsdtTransaction, RpcUsdtTransactionKind, RpcUsdtWithdrawalStatus,
};
use rpc_types::{
    EcashReceiveMetadata, EcashReceiveReason, EcashSendMetadata, FrontendMetadata, RpcAmount,
    RpcEcashUnit,
};
use runtime::utils::to_unix_time;
use tracing::{debug, info, warn};

use super::FederationV2;
use super::client::ClientExt as _;

/// How long a deposit address handed out by `usdtGenerateDepositAddress`
/// stays "hot" (polled at [`USDT_HOT_POLL_INTERVAL`] by the deposit service)
/// before falling back to the slow full-scan cadence. The address stays
/// valid forever either way.
const DEPOSIT_WATCH_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

/// Fast poll cadence of the USDT deposit service for the hot (most recently
/// handed out) deposit address. The e2e test relies on this being small
/// relative to its wait-for-claim deadline.
pub const USDT_HOT_POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Cadence of the USDT deposit service's full pass over ALL known deposit
/// addresses (attempt a deposit-proof submission for each + drain any legacy
/// observation-model `claimable` balance). Catches late deposits to old
/// addresses.
pub const USDT_FULL_SCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// How long we poll a submitted withdrawal for on-chain confirmation.
const WITHDRAWAL_WATCH_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

/// Federation meta key a federation operator can set to point clients at a
/// specific EVM JSON-RPC endpoint for deposit-proof fetching (the
/// `eth_getProof` and `eth_getBlockByNumber` calls of [`EthJsonRpc`]) --
/// operator-controlled without an app update. The value is the plain URL
/// string (an optional surrounding pair of JSON double quotes is tolerated).
/// Absent or empty means the client module's built-in keyless mainnet
/// default list ([`DEFAULT_EVM_RPC_URLS`]) is used.
pub const USDT_EVM_RPC_URL_META_KEY: &str = "usdt:evm_rpc_url";

impl FederationV2 {
    /// Whether the joined federation runs the usdt module.
    pub fn usdt_supported(&self) -> bool {
        self.client.usdt().is_ok()
    }

    /// The unit a legacy (unitless) e-cash note from this federation is
    /// denominated in, `None` if the federation has no mintv2 module.
    ///
    /// Consulted only as the fallback in `validate_ecash` for notes that
    /// predate the on-note unit field. A federation may carry several mintv2
    /// instances; we prefer the BITCOIN unit because legacy unitless notes
    /// are always Bitcoin-denominated (the on-note unit field arrived
    /// together with the USDT-denominated mint).
    pub async fn ecash_unit(&self) -> Option<rpc_types::RpcEcashUnit> {
        let units: Vec<_> = self
            .client
            .mintv2_instances()
            .await
            .iter()
            .map(|instance| instance.amount_unit())
            .collect();
        if units.contains(&fedimint_core::module::AmountUnit::BITCOIN) {
            Some(rpc_types::RpcEcashUnit::Bitcoin)
        } else if units.contains(&USDT_UNIT) {
            Some(rpc_types::RpcEcashUnit::Usdt)
        } else if units.is_empty() {
            None
        } else {
            Some(rpc_types::RpcEcashUnit::Other)
        }
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

    /// Returns the current deposit address, allocating a fresh one only if
    /// the newest allocated address has already received a deposit (so
    /// repeated calls hand out the SAME address until it is actually used),
    /// and marks it hot so the deposit service polls it at a fast cadence.
    /// The claim into USDT e-cash happens in the background once the
    /// federation credits the deposit.
    pub async fn usdt_generate_deposit_address(&self) -> Result<String> {
        let usdt = self.client.usdt()?;
        let (_keypair, address, newly_allocated) = usdt.current_or_allocate_deposit().await?;
        if newly_allocated {
            info!(%address, "allocated a fresh usdt deposit address");
        }
        // Mark the address hot: the deposit service wakes on this watch
        // channel and polls it every USDT_HOT_POLL_INTERVAL until the
        // deposit is claimed or the hint expires.
        let expires_at = fedimint_core::time::now() + DEPOSIT_WATCH_DEADLINE;
        self.usdt_deposit_hint
            .send_replace(Some((address, expires_at)));
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

    /// One pass over all known deposit addresses under the deposit-by-proof
    /// model (guardians no longer watch deposit addresses; crediting happens
    /// ONLY when this client submits an `eth_getProof` balance proof):
    /// - attempts a deposit-proof submission for each address (fetch the proof
    ///   at the federation's newest anchored block, submit if it proves
    ///   anything new -- credit + mint atomic, no deposit fee);
    /// - drains any LEGACY observation-model balance (`claimable > 0`, credited
    ///   by guardians before the proof model) via the old `claim` path, fee
    ///   guard intact.
    ///
    /// Returns the number of deposits credited/claimed.
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
            match self.usdt_try_submit_deposit_proof(address, &keypair).await {
                Ok(true) => claimed += 1,
                Ok(false) => {}
                Err(err) => {
                    warn!(%address, ?err, "usdt deposit-proof submission failed, will retry");
                }
            }
            // Legacy drain: balances credited by guardians under the
            // pre-proof observation model stay claimable through the old
            // (fee-charging) claim path until drained.
            match self.usdt_claim_if_claimable(address, claim_pk).await {
                Ok(true) => claimed += 1,
                Ok(false) => {}
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
        // `check_uncredited: true`: also persist the claim keys of scanned
        // addresses that show no credit yet, so a transfer the federation
        // never credited (crediting is proof-driven and this seed's previous
        // device may never have submitted one) is picked up by the
        // `usdt_check_deposits` proof pass below.
        let summary = usdt.recover_deposits(20, true).await?;
        info!(?summary, "usdt deposit recovery finished");
        self.usdt_check_deposits().await
    }

    /// Quote for the on-chain fee of withdrawing `amount` right now, in
    /// 10^-6 USDT units. The fee is deducted from the withdrawn amount by
    /// the federation.
    ///
    /// Errors (surfaced to the frontend as a plain RpcError) when the
    /// federation has no usable fee quote yet (no fresh fee-vote median);
    /// the client module bails instead of returning a `0` placeholder that
    /// a subsequent withdraw would be rejected against.
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

    /// Generates USDT-denominated e-cash notes (amount in 10^-6 USDT units),
    /// e.g. for an in-chat payment. Per product decision, USDT e-cash
    /// carries no Fedi fees.
    pub async fn usdt_generate_ecash(
        &self,
        amount: RpcUsdtAmount,
        include_invite: bool,
        frontend_meta: FrontendMetadata,
    ) -> Result<RpcUsdtGenerateEcashResponse> {
        let _guard = self.generate_ecash_lock.lock().await;
        let mintv2 = self.client.mintv2_of_unit(USDT_UNIT).await?;
        if amount.0 == 0 {
            bail!("amount must be positive");
        }
        let spend_guard = self.spend_guard.lock().await;
        let balance = self.client.get_balance_for_unit(USDT_UNIT).await?;
        // `mintv2.send` rounds the spend UP to the next multiple of the
        // smallest client denomination (512 msats = 2^9; see
        // fedimint-mintv2-client's `round_to_multiple` over
        // `client_denominations()`). Validate against that POST-rounding
        // amount, not the raw request, so a near-full-balance send fails this
        // friendly guard here rather than deep inside `send` once the rounding
        // pushes it over balance.
        const MINTV2_MIN_DENOMINATION_MSATS: u64 = 512;
        let rounded_amount = amount.0.next_multiple_of(MINTV2_MIN_DENOMINATION_MSATS);
        if rounded_amount > balance.msats {
            bail!(ErrorCode::InsufficientBalance(RpcAmount(balance)));
        }
        let custom_meta = serde_json::to_value(EcashSendMetadata {
            internal: false,
            frontend_metadata: Some(frontend_meta),
            unit: RpcEcashUnit::Usdt,
        })?;
        let (operation_id, ecash) = mintv2
            .send(fedimint_core::Amount::from_msats(amount.0), custom_meta)
            .await?;
        drop(spend_guard);
        let ecash = self
            .stamp_and_encode_generated_ecash(ecash, USDT_UNIT, include_invite)
            .await;
        Ok(RpcUsdtGenerateEcashResponse {
            ecash,
            operation_id: rpc_types::RpcOperationId(operation_id),
        })
    }

    /// Redeems USDT-denominated e-cash notes into our balance (fee-free),
    /// returning the received amount in 10^-6 USDT units.
    pub async fn usdt_receive_ecash(&self, ecash: String) -> Result<RpcUsdtAmount> {
        let mintv2 = self.client.mintv2_of_unit(USDT_UNIT).await?;
        let decoded: MintV2ECash = decode_prefixed(FEDIMINT_PREFIX, &ecash)?;
        let amount = decoded.amount();
        let custom_meta = serde_json::to_value(EcashReceiveMetadata {
            internal: false,
            reason: EcashReceiveReason::Receive,
            frontend_metadata: None,
            unit: RpcEcashUnit::Usdt,
        })?;
        let operation_id = mintv2.receive(decoded, custom_meta).await?;
        let final_state = mintv2
            .await_final_receive_operation_state(operation_id)
            .await?;
        self.send_transaction_event(operation_id).await;
        match final_state {
            MintV2FinalReceiveOperationState::Success => Ok(RpcUsdtAmount(amount.msats)),
            MintV2FinalReceiveOperationState::Rejected => {
                // Tag with `ErrorCode::EcashAlreadySpent` (mirroring the
                // mintv1 receive path in mint_ops/v1.rs) so JS can match on
                // the serialized `errorCode` ("ecashAlreadySpent") instead of
                // an exact error string. `mintv2.receive` rejects an
                // already-spent note here.
                bail!(ErrorCode::EcashAlreadySpent)
            }
        }
    }

    /// USDT transaction history from the operation log: on-chain deposits
    /// (usdt module claims) and withdrawals, plus USDT e-cash sends/receives
    /// (USDT-denominated mintv2 operations). Newest first.
    ///
    /// `start_time` is an exclusive cursor (Unix seconds): when given, only
    /// entries strictly older than it are returned. It mirrors the
    /// `listTransactions` cursor convention — callers page by handing back the
    /// [`RpcUsdtTransaction::created_at`] of the oldest row they last saw.
    ///
    /// The operation log is paged in fixed chunks and mapped/filtered to
    /// USDT-relevant entries as we go, accumulating until we have `limit` of
    /// them or the log is exhausted. Filtering happens BEFORE the limit is
    /// applied, so internal mintv2 reissues (and, in a mixed BTC+USDT
    /// federation, BITCOIN-unit mintv2 operations) can never starve the
    /// window down to fewer — or zero — user-facing rows.
    pub async fn usdt_list_transactions(
        &self,
        limit: usize,
        start_time: Option<u64>,
    ) -> Result<Vec<RpcUsdtTransaction>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let include_mintv2 = self.client.mintv2_of_unit(USDT_UNIT).await.is_ok();

        // Chunk size for each `paginate_operations_rev` call. Independent of
        // `limit`: we keep paging in chunks of this size until enough
        // USDT-relevant entries have accumulated.
        const PAGE_SIZE: usize = 100;

        // Build the initial exclusive cursor from `start_time`, mirroring
        // `list_transactions`' `ChronologicalOperationLogKey` convention (the
        // operation_id component is irrelevant at second granularity).
        let mut cursor = start_time.map(|secs| ChronologicalOperationLogKey {
            creation_time: UNIX_EPOCH + Duration::from_secs(secs),
            operation_id: OperationId::new_random(),
        });

        let mut transactions = Vec::new();
        loop {
            let page = self
                .client
                .operation_log()
                .paginate_operations_rev(PAGE_SIZE, cursor)
                .await;
            let page_len = page.len();
            // Cursor for the next page: strictly-older-than the oldest entry
            // we just saw (the page is newest-first).
            let next_cursor = page.last().map(|(key, _)| *key);

            for (op_key, entry) in page {
                let Ok(created_at) = to_unix_time(op_key.creation_time) else {
                    continue;
                };
                let tx = match entry.operation_module_kind() {
                    "usdt" => match entry.try_meta::<UsdtOperationMeta>() {
                        Ok(UsdtOperationMeta::Claim {
                            account,
                            amount,
                            fee,
                        }) => Some(RpcUsdtTransaction {
                            created_at,
                            // the e-cash actually issued is amount - fee
                            amount: RpcUsdtAmount(amount.0.saturating_sub(fee.0)),
                            incoming: true,
                            kind: RpcUsdtTransactionKind::Deposit {
                                address: account.to_string(),
                            },
                        }),
                        Ok(UsdtOperationMeta::Withdraw {
                            recipient,
                            amount,
                            txid,
                            ..
                        }) => Some(RpcUsdtTransaction {
                            created_at,
                            amount: RpcUsdtAmount(amount.0),
                            incoming: false,
                            kind: RpcUsdtTransactionKind::Withdrawal {
                                recipient: recipient.to_string(),
                                txid: txid.map(|txid| txid.to_string()),
                            },
                        }),
                        // The usdt module kind is unique to the USDT-denominated
                        // instance, so Claim/Withdraw are never ambiguous in a
                        // mixed federation — no unit filter needed here.
                        Err(_) => None,
                    },
                    "mintv2" if include_mintv2 => {
                        match entry.try_meta::<MintV2OperationMeta>() {
                            // Only USDT-unit mintv2 sends/receives belong in USDT
                            // history. In a mixed BTC+USDT federation a BITCOIN
                            // mintv2 send/receive would otherwise have its msats
                            // misread as USDT micros (a 1000-sat note rendering as
                            // 1 USDT). We stamp the unit into our own custom_meta
                            // at write time (usdt.rs and mint_ops/v2.rs) and filter
                            // on it here. Entries whose custom_meta predates the
                            // stamp deserialize to `Bitcoin` (serde default) and are
                            // excluded — safe, because mixed federations only became
                            // possible on this branch, so no pre-stamp local op can
                            // be a USDT one.
                            Ok(MintV2OperationMeta::Send { ecash, custom_meta }) => {
                                serde_json::from_value::<EcashSendMetadata>(custom_meta)
                                    .ok()
                                    .filter(|meta| meta.unit == RpcEcashUnit::Usdt)
                                    .and_then(|_| usdt_ecash_amount(&ecash))
                                    .map(|amount| RpcUsdtTransaction {
                                        created_at,
                                        amount,
                                        incoming: false,
                                        kind: RpcUsdtTransactionKind::EcashSend,
                                    })
                            }
                            Ok(MintV2OperationMeta::Receive {
                                ecash, custom_meta, ..
                            }) => serde_json::from_value::<EcashReceiveMetadata>(custom_meta)
                                .ok()
                                .filter(|meta| meta.unit == RpcEcashUnit::Usdt)
                                .and_then(|_| usdt_ecash_amount(&ecash))
                                .map(|amount| RpcUsdtTransaction {
                                    created_at,
                                    amount,
                                    incoming: true,
                                    kind: RpcUsdtTransactionKind::EcashReceive,
                                }),
                            // reissues are internal bookkeeping, not user payments
                            Ok(MintV2OperationMeta::Reissue { .. }) | Err(_) => None,
                        }
                    }
                    _ => None,
                };
                if let Some(tx) = tx {
                    transactions.push(tx);
                    if transactions.len() >= limit {
                        return Ok(transactions);
                    }
                }
            }

            // A short page means the log is exhausted; stop before an
            // empty-page round-trip.
            if page_len < PAGE_SIZE {
                break;
            }
            cursor = next_cursor;
        }
        Ok(transactions)
    }

    /// Spawns the long-lived per-federation USDT deposit service (replaces
    /// the old one-shot startup claimer and the fire-and-forget per-address
    /// watchers). It never dies on errors: transient federation-API failures
    /// are logged and retried on the next tick, never surfaced as `Failed`.
    pub(super) fn spawn_usdt_deposit_service(&self) {
        if !self.usdt_supported() {
            return;
        }
        self.spawn_cancellable("usdt_deposit_service", |fed| async move {
            fed.run_usdt_deposit_service().await;
        });
    }

    /// The deposit service loop, two cadences in one:
    /// - the "hot" address (most recently handed out via
    ///   `usdtGenerateDepositAddress`, tracked in-memory via
    ///   `usdt_deposit_hint`) is polled every [`USDT_HOT_POLL_INTERVAL`] until
    ///   claimed or the hint expires;
    /// - a full pass over ALL known addresses runs every
    ///   [`USDT_FULL_SCAN_INTERVAL`] (the first pass runs immediately, claiming
    ///   deposits that landed while the app was closed).
    ///
    /// Each poll fetches an `eth_getProof` balance proof of the address at
    /// the federation's newest anchored block and submits it when it proves
    /// anything new (deposit-by-proof: credit + mint atomic, no deposit fee),
    /// plus drains any legacy observation-model `claimable` balance through
    /// the old claim path.
    async fn run_usdt_deposit_service(&self) {
        // Mirror an operator-configured EVM RPC URL (federation meta) into
        // the client module's own persisted override, so any client-internal
        // URL resolution (`submit_deposit_proof`'s default path) agrees with
        // the bridge-side resolution in `usdt_evm_rpc_urls`.
        if let Ok(usdt) = self.client.usdt()
            && let Some(url) = self.usdt_meta_evm_rpc_url().await
        {
            usdt.set_evm_rpc_url(Some(url)).await;
        }

        let mut hint_rx = self.usdt_deposit_hint.subscribe();
        let mut next_full_scan = fedimint_core::time::now();
        loop {
            if fedimint_core::time::now() >= next_full_scan {
                match self.usdt_check_deposits().await {
                    Ok(0) => {}
                    Ok(n) => info!(claimed = n, "usdt deposit service claimed deposits"),
                    // Transient (e.g. mobile connectivity blip): warn and
                    // retry next pass, never die, never emit Failed.
                    Err(err) => warn!(?err, "usdt deposit full scan failed, will retry"),
                }
                next_full_scan = fedimint_core::time::now() + USDT_FULL_SCAN_INTERVAL;
            }

            let hot = *hint_rx.borrow_and_update();
            let hot_active = match hot {
                Some((address, expires_at)) => {
                    if fedimint_core::time::now() >= expires_at {
                        info!(%address, "usdt hot deposit window expired without a deposit");
                        self.usdt_clear_deposit_hint(address);
                        false
                    } else {
                        if let Err(err) = self.usdt_poll_hot_deposit(address).await {
                            warn!(%address, ?err, "usdt hot deposit poll failed, will retry");
                        }
                        true
                    }
                }
                None => false,
            };

            let sleep_for = if hot_active {
                USDT_HOT_POLL_INTERVAL
            } else {
                next_full_scan
                    .duration_since(fedimint_core::time::now())
                    .unwrap_or(Duration::ZERO)
            };
            tokio::select! {
                () = sleep(sleep_for) => {}
                // Wakes immediately when usdtGenerateDepositAddress installs
                // a new hot address (or a claim/expiry clears it).
                changed = hint_rx.changed() => {
                    if changed.is_err() {
                        // Sender dropped: the federation object is gone.
                        return;
                    }
                }
            }
        }
    }

    /// One fast-cadence poll of the hot deposit address: attempt a
    /// deposit-proof submission, then drain any legacy observation-model
    /// `claimable` balance (a pre-upgrade current address may still carry
    /// one).
    async fn usdt_poll_hot_deposit(&self, address: EvmAddress) -> Result<()> {
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
        self.usdt_try_submit_deposit_proof(address, &keypair)
            .await?;
        self.usdt_claim_if_claimable(address, claim_pk).await?;
        Ok(())
    }

    /// Reads the operator-configured EVM RPC URL from federation meta
    /// ([`USDT_EVM_RPC_URL_META_KEY`]), `None` when unset/empty.
    async fn usdt_meta_evm_rpc_url(&self) -> Option<String> {
        let meta = self.get_cached_meta().await;
        let url = meta.get(USDT_EVM_RPC_URL_META_KEY)?.trim();
        // Tolerate a JSON-quoted value (fedimint meta values are raw strings,
        // but operators sometimes paste them JSON-encoded).
        let url = url
            .strip_prefix('"')
            .and_then(|u| u.strip_suffix('"'))
            .unwrap_or(url)
            .trim();
        if url.is_empty() {
            return None;
        }
        Some(url.to_string())
    }

    /// Resolves the EVM JSON-RPC endpoint list the deposit service fetches
    /// deposit proofs from, in precedence order: the in-memory test/debug
    /// override (`usdt_set_evm_rpc_url_override`), then the
    /// [`USDT_EVM_RPC_URL_META_KEY`] federation meta key (operator-controlled
    /// without an app update), then the client module's built-in keyless
    /// mainnet defaults ([`DEFAULT_EVM_RPC_URLS`], tried in order with the
    /// client's per-call timeout cap).
    async fn usdt_evm_rpc_urls(&self) -> Vec<String> {
        if let Some(url) = self
            .usdt_evm_rpc_override
            .lock()
            .expect("usdt evm rpc override mutex poisoned")
            .clone()
        {
            return vec![url];
        }
        if let Some(url) = self.usdt_meta_evm_rpc_url().await {
            return vec![url];
        }
        DEFAULT_EVM_RPC_URLS
            .iter()
            .map(|s| (*s).to_string())
            .collect()
    }

    /// Sets (or clears, with `None`) the in-memory EVM RPC endpoint override
    /// consulted first by [`Self::usdt_evm_rpc_urls`]. Test/debug hook -- the
    /// e2e points the deposit service at its anvil devnet with this; real
    /// deployments use the [`USDT_EVM_RPC_URL_META_KEY`] federation meta key
    /// instead.
    pub fn usdt_set_evm_rpc_url_override(&self, url: Option<String>) {
        *self
            .usdt_evm_rpc_override
            .lock()
            .expect("usdt evm rpc override mutex poisoned") = url;
    }

    /// Attempts to credit `address`'s on-chain USDT balance by fetching an
    /// `eth_getProof` balance proof at the federation's newest anchored block
    /// and submitting it (deposit-by-proof: credit + mint atomic, NO deposit
    /// fee). Runs under the federation-wide `usdt_claim_guard` so concurrent
    /// submitters (the deposit service and the
    /// `usdtCheckDeposits`/`usdtRecoverDeposits` paths) can't race each other
    /// into rejected transactions.
    ///
    /// The proof fetch doubles as the pre-check: an empty, never-credited
    /// account (`proven == 0 && credited == 0` -- the common
    /// no-deposit-yet case for a hot address) submits nothing. Anything else
    /// is handed to the client module, whose sweep-aware delta rule decides;
    /// its "nothing new to credit" refusal is a benign no-op here, and any
    /// other failure (e.g. a proof gone stale because the anchor rotated
    /// mid-flight, or the anchored block still predating a just-made deposit)
    /// surfaces as `Err` for the caller to `warn!` -- the service simply
    /// retries on its normal cadence and NEVER emits a user-facing Failed
    /// event.
    ///
    /// On success emits the `Claimed` event with the full credited delta (no
    /// fee on this path, so the event amount equals the minted e-cash) and
    /// rotates the hot hint off the address. Returns whether anything was
    /// credited.
    async fn usdt_try_submit_deposit_proof(
        &self,
        address: EvmAddress,
        keypair: &Keypair,
    ) -> Result<bool> {
        let usdt = self.client.usdt()?;
        let _guard = self.usdt_claim_guard.lock().await;

        let anchored = usdt.latest_anchored_block().await?;
        if anchored.latest == 0 {
            // The federation has not anchored any confirmation-deep block
            // yet; nothing to prove against. Retry next tick.
            debug!(%address, "usdt deposit proof: no anchored block yet, retrying next tick");
            return Ok(false);
        }

        let claim_pk = keypair.public_key();
        let before = usdt.deposit_status(claim_pk).await?;

        let (proof, proven) = EthJsonRpc::new(self.usdt_evm_rpc_urls().await)?
            .fetch_deposit_proof(usdt.config().usdt_contract, address, anchored.latest)
            .await?;
        if proven.0 == 0 && before.credited.0 == 0 {
            // Empty account that was never credited: nothing a proof could
            // add. (A once-credited account is NOT skipped even at
            // `proven == 0`: after a server-side sweep the post-sweep proven
            // balance resets while `credited` stays, and only the client
            // module's sweep-aware rule can tell whether anything is new.)
            debug!(
                %address,
                anchored = anchored.latest,
                "usdt deposit proof pre-check: account empty and never credited, nothing to submit"
            );
            return Ok(false);
        }

        match usdt
            .submit_prebuilt_deposit_proof(keypair, proof, proven)
            .await
        {
            Ok(_) => {}
            // The client refuses proofs that prove nothing over the already
            // credited total -- the normal steady state for an address whose
            // deposit was already credited. Benign, not an error.
            Err(err) if err.to_string().contains("nothing new to credit") => {
                debug!(%address, "usdt deposit proof proves nothing new");
                return Ok(false);
            }
            Err(err) => return Err(err),
        }

        // No deposit fee on the proof path: the minted e-cash equals the
        // newly credited delta.
        let after = usdt.deposit_status(claim_pk).await?;
        let credited = UsdtAmount(after.credited.0.saturating_sub(before.credited.0));
        self.emit_usdt_deposit_claimed(address, credited);
        self.usdt_clear_deposit_hint(address);
        Ok(true)
    }

    /// Claims `address`'s deposit if anything is claimable right now, under
    /// the federation-wide `usdt_claim_guard` so concurrent claimers (the
    /// deposit service and the `usdtCheckDeposits`/`usdtRecoverDeposits`
    /// paths) can't race each other into rejected claim transactions.
    /// Emits the `Claimed` event (net of the deposit fee, matching history
    /// and balance) and rotates the hot hint off the address on success.
    /// Returns whether a claim was made.
    ///
    /// LEGACY drain: under the deposit-by-proof model crediting and minting
    /// are atomic (`usdt_try_submit_deposit_proof`), so `claimable` can only
    /// be nonzero for balances the guardians credited under the pre-proof
    /// observation model. This path (and its deposit-fee semantics) exists to
    /// drain those.
    async fn usdt_claim_if_claimable(
        &self,
        address: EvmAddress,
        claim_pk: PublicKey,
    ) -> Result<bool> {
        let usdt = self.client.usdt()?;
        let _guard = self.usdt_claim_guard.lock().await;
        // Re-read under the guard: another claimer may have won the race
        // since the caller last looked.
        let status = usdt.deposit_status(claim_pk).await?;
        if status.claimable.0 == 0 {
            return Ok(false);
        }
        // `(None, false)`: no explicit fee ceiling, and do NOT bypass the
        // client's default fee-sanity guard, which refuses to claim while
        // the federation's deposit fee quote eats more than a sanity
        // percentage of the claimable amount. A refusal surfaces as an
        // `Err` here BEFORE any e-cash is minted; our callers only `warn!`
        // and never emit a user-facing Failed event, and the deposit
        // service simply retries on its normal cadence (15s hot poll /
        // 10min full scan), so a fee-spiked deposit is claimed later at a
        // sane fee instead of silently overpaying now.
        let result = usdt.claim(claim_pk, None, false).await?;
        // The e-cash actually issued is claimed - fee; report net so the
        // event amount matches history and the balance delta.
        let net = UsdtAmount(result.claimed.0.saturating_sub(result.fee.0));
        self.emit_usdt_deposit_claimed(address, net);
        self.usdt_clear_deposit_hint(address);
        Ok(true)
    }

    /// Clears the hot-address hint if it still points at `address` (claimed
    /// or expired), waking the deposit service to fall back to the slow
    /// cadence and letting the next `usdtGenerateDepositAddress` rotate.
    fn usdt_clear_deposit_hint(&self, address: EvmAddress) {
        self.usdt_deposit_hint.send_if_modified(|hint| {
            if hint.is_some_and(|(hot, _)| hot == address) {
                *hint = None;
                true
            } else {
                false
            }
        });
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

    /// Spawns the watcher polling a withdrawal to its terminal status and
    /// emitting `UsdtWithdrawal` events on every status change. Called on
    /// `usdt_withdraw` and re-armed for in-flight withdrawals on restart
    /// (see the `"usdt"` arm of `subscribe_to_operation` in mod.rs).
    pub(super) fn spawn_usdt_withdrawal_watcher(&self, txid: TransactionId) {
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

/// Map a mintv2 [`AmountUnit`] to the RPC-facing e-cash unit tag.
pub(crate) fn rpc_ecash_unit(unit: fedimint_core::module::AmountUnit) -> rpc_types::RpcEcashUnit {
    if unit == fedimint_core::module::AmountUnit::BITCOIN {
        rpc_types::RpcEcashUnit::Bitcoin
    } else if unit == USDT_UNIT {
        rpc_types::RpcEcashUnit::Usdt
    } else {
        rpc_types::RpcEcashUnit::Other
    }
}

/// Decode the raw USDT amount carried inside a mintv2 e-cash string.
fn usdt_ecash_amount(ecash: &str) -> Option<RpcUsdtAmount> {
    decode_prefixed::<MintV2ECash>(FEDIMINT_PREFIX, ecash)
        .ok()
        .map(|e| RpcUsdtAmount(e.amount().msats))
}
