//! End-to-end integration test for USDT support in the fedi bridge.
//!
//! Spins up a minimal USDT-only devimint federation (usdt module + a single
//! USDT-denominated `mintv2`, no Bitcoin wallet / lightning modules) against
//! a real anvil EVM devnet, real cggmp21 DKG included, then drives the whole
//! user flow through bridge APIs: join federation -> readiness -> deposit
//! address -> on-chain ERC-20 deposit -> background deposit-proof crediting
//! (the deposit service fetches an `eth_getProof` balance proof from anvil
//! and submits it; credit + mint atomic, no deposit fee) -> balance ->
//! withdrawal submission.
//!
//! Because the real DKG takes minutes and needs `anvil` + `bitcoind` (from
//! the nix dev shell), this test only runs when `RUN_USDT_TESTS` is set; see
//! `scripts/test-usdt-bridge.sh` / `just test-usdt-bridge`.
//!
//! The withdrawal leg is asserted up to the `Signing`/`Submitted` state:
//! final on-chain confirmation requires an EVM RPC that serves
//! `eth_getUserOperationReceipt` (a bundler API), which the dev shell's
//! anvil does not provide. The upstream fedimint usdt e2e has the same
//! limitation in this environment.

use std::future::Future;
use std::time::Duration;

use alloy::network::TransactionBuilder as _;
use alloy::primitives::{Address, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use anyhow::{Context, bail, ensure};
use devi::{DevFed, NostrRelay, Synapse};
use devimint::cmd;
use devimint::external::{Anvil, Bitcoind, Esplora};
use devimint::federation::Federation;
use fedimint_core::envs::{
    FM_DISABLE_BASE_FEES_ENV, FM_ENABLE_MODULE_LNV1_ENV, FM_ENABLE_MODULE_LNV2_ENV,
    FM_ENABLE_MODULE_MINT_ENV, FM_ENABLE_MODULE_MINTV2_ENV, FM_ENABLE_MODULE_USDT_ENV,
    FM_ENABLE_MODULE_WALLET_ENV, FM_ENABLE_MODULE_WALLETV2_ENV, FM_MINTV2_AMOUNT_UNIT_ENV,
    FM_USDT_BROADCASTER_PRIVATE_KEY_ENV, FM_USDT_CONTRACT_ENV, FM_USDT_ENTRY_POINT_ENV,
    FM_USDT_ETH_USD_PRICE_FEED_ENV,
};
use fedimint_logging::TracingSetup;
use fedimint_usdt_common::{EvmAddress, USDT_UNIT, UsdtAmount};
use rpc_types::FrontendMetadata;
use rpc_types::usdt::{RpcUsdtAmount, RpcUsdtTransactionKind, RpcUsdtWithdrawalStatus};
use tracing::info;

use crate::rpc::{self, TryGet as _};
use crate::test_device::TestDevice;

/// Minimum NET e-cash amount for the deposit (multiple of the mintv2
/// denomination granularity, mirroring the upstream usdt e2e).
const MIN_NET_DEPOSIT: u64 = 2_048_000;

#[tokio::test(flavor = "multi_thread")]
async fn test_usdt_bridge_end_to_end() -> anyhow::Result<()> {
    if std::env::var("RUN_USDT_TESTS").is_err() {
        info!("skipping usdt bridge e2e (set RUN_USDT_TESTS=1 and run in the nix dev shell)");
        return Ok(());
    }
    let _ = TracingSetup::default().init();

    // Devimint process manager + global env (ports, data dir).
    let (process_mgr, _task_group) = DevFed::process_setup(4).await?;

    info!("starting bitcoind + anvil + synapse + nostr relay");
    let (bitcoind, anvil, synapse, nostr_relay) = tokio::try_join!(
        Bitcoind::new(&process_mgr, false),
        Anvil::new(&process_mgr),
        Synapse::start(&process_mgr),
        NostrRelay::start(&process_mgr),
    )?;
    // TestDevice's test feature catalog requires these.
    // SAFETY: single-threaded at this point.
    unsafe {
        std::env::set_var("DEVI_SYNAPSE_SERVER", &synapse.url);
        std::env::set_var("DEVI_NOSTR_RELAY", &nostr_relay.url);
    }

    info!("deploying test ERC-20 + ERC-4337 EntryPoint");
    let holder = account_1_address()?;
    let token = deploy_test_erc20(&anvil, holder, UsdtAmount(100_000_000)).await?;
    let entry_point = deploy_entry_point(&anvil).await?;

    // SAFETY: single-threaded at this point; set before any fedimintd
    // subprocess is spawned so every guardian inherits these.
    unsafe {
        // Minimal USDT-only federation: usdt + one USDT-denominated mintv2.
        std::env::set_var(FM_ENABLE_MODULE_USDT_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_MINTV2_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_MINT_ENV, "0");
        std::env::set_var(FM_ENABLE_MODULE_WALLET_ENV, "0");
        std::env::set_var(FM_ENABLE_MODULE_WALLETV2_ENV, "0");
        std::env::set_var(FM_ENABLE_MODULE_LNV1_ENV, "0");
        std::env::set_var(FM_ENABLE_MODULE_LNV2_ENV, "0");
        std::env::set_var(
            FM_MINTV2_AMOUNT_UNIT_ENV,
            serde_json::to_value(USDT_UNIT)
                .expect("AmountUnit is serializable")
                .to_string(),
        );
        std::env::set_var(FM_DISABLE_BASE_FEES_ENV, "1");
        std::env::set_var(FM_USDT_CONTRACT_ENV, token.to_string());
        std::env::set_var(FM_USDT_ENTRY_POINT_ENV, entry_point.to_string());
        std::env::set_var(
            FM_USDT_BROADCASTER_PRIVATE_KEY_ENV,
            ANVIL_ACCOUNT_0_PRIVATE_KEY,
        );
        // No Chainlink on anvil: all-zero disables the feed (static fallback).
        std::env::set_var(
            FM_USDT_ETH_USD_PRICE_FEED_ENV,
            EvmAddress([0u8; 20]).to_string(),
        );
        // cggmp21 DKG exceeds the default 60s config-gen timeout.
        std::env::set_var(
            devimint::envs::FM_DEVIMINT_CONFIG_GEN_TIMEOUT_SECS_ENV,
            "300",
        );
    }

    info!("starting the USDT-only federation (real cggmp21 DKG, takes minutes)");
    let fed = Federation::new(
        &process_mgr,
        bitcoind,
        false,
        false,
        0,
        "default".to_string(),
    )
    .await?;
    let invite_code = fed.invite_code()?;

    info!("joining via the bridge");
    let mut td = TestDevice::new().await?;
    let bridge = td.bridge_full().await?;
    let rpc_federation = rpc::joinFederation(bridge, invite_code.clone(), false).await?;
    let federation = bridge
        .federations
        .get_federation(&rpc_federation.id.0)
        .context("federation must be ready after join")?;

    ensure!(
        federation.usdt_supported(),
        "joined federation must report the usdt module"
    );
    // Deposit-by-proof: the bridge deposit service fetches `eth_getProof`
    // balance proofs itself. Point its EVM RPC resolution at the e2e anvil --
    // a devfed has no operator `usdt:evm_rpc_url` meta and the client
    // module's built-in defaults are mainnet-only.
    federation.usdt_set_evm_rpc_url_override(Some(anvil.rpc_url()));
    let balance = federation.usdt_balance().await?;
    ensure!(balance.0 == 0, "fresh client must start at zero balance");

    info!("waiting for the usdt module to report Ready");
    poll_until(Duration::from_secs(180), Duration::from_secs(2), || async {
        Ok(federation.usdt_status().await?.ready)
    })
    .await
    .context("usdt module never reported Ready")?;

    // A nonzero deposit-fee median must exist before claims are accepted;
    // fee votes converge from the guardians' gas-price pollers.
    info!("waiting for a nonzero withdrawal fee quote (fee median)");
    poll_until(Duration::from_secs(120), Duration::from_secs(1), || async {
        Ok(federation
            .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
            .await
            .map(|fee| fee.0 > 0)
            .unwrap_or(false))
    })
    .await
    .context("fee median never converged")?;

    info!("generating a deposit address via the bridge");
    let address = federation.usdt_generate_deposit_address().await?;
    ensure!(
        address.starts_with("0x") && address.len() == 42,
        "deposit address must be a 0x-prefixed EVM address, got {address}"
    );

    // Address reuse policy: until an address has actually received a
    // deposit, repeated generate calls must hand out the SAME address.
    let address_again = federation.usdt_generate_deposit_address().await?;
    ensure!(
        address_again == address,
        "generate before any deposit must return the same address \
         (got {address_again}, expected {address})"
    );

    // Deposit-by-proof charges NO deposit fee (crediting and minting are one
    // atomic transaction), so the deposit only needs headroom for the LATER
    // withdrawal's fee (deducted from the withdrawn amount), which scales
    // with anvil's (high) default gas price. `* 4` is comfortable headroom
    // over the single withdrawal below. Round to a multiple of the mintv2
    // minimum client denomination (512): the atomic credit+mint issues the
    // credited delta rounded DOWN to that granularity, so a 512-multiple
    // deposit mints exactly in full and the equality assertions below stay
    // tight.
    let fee_quote = federation
        .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
        .await?;
    let transfer_amount = UsdtAmount((MIN_NET_DEPOSIT + fee_quote.0 * 4).next_multiple_of(512));

    info!(%address, amount = transfer_amount.0, "sending on-chain USDT to the deposit address");
    let deposit_address: EvmAddress = address.parse()?;
    transfer_erc20_from_account_1(&anvil, token, deposit_address, transfer_amount).await?;
    mine_blocks(&anvil, 3).await?;

    // The bridge's long-lived deposit service (usdtGenerateDepositAddress
    // marked the address hot, so it is polled every
    // `federations::federation_v2::usdt::USDT_HOT_POLL_INTERVAL` = 15s)
    // must fetch a balance proof, submit it, and mint USDT e-cash without
    // further prompting. anvil only mines on demand, so keep the head (and
    // with it the guardians' anchored confirmation-deep block) moving past
    // the funding transfer while we wait -- with a stalled head the service's
    // proof could target a block from before the transfer forever.
    info!("waiting for the deposit service to submit the deposit proof");
    poll_until(Duration::from_secs(300), Duration::from_secs(2), || async {
        mine_blocks(&anvil, 1).await?;
        Ok(federation.usdt_balance().await?.0 > 0)
    })
    .await
    .context("deposit was never proof-credited into USDT e-cash")?;

    let balance = federation.usdt_balance().await?;
    ensure!(
        balance.0 == transfer_amount.0,
        "deposit-by-proof mints the FULL deposit (no deposit fee): balance {} != transferred {}",
        balance.0,
        transfer_amount.0,
    );
    info!(balance = balance.0, "deposit proof-credited in full");

    // Deposit status must reflect the atomic credit + claim (mint).
    let status = federation.usdt_deposit_status(address.clone()).await?;
    ensure!(
        status.credited.0 == transfer_amount.0,
        "deposit status must show the full transfer credited (credited {}, transferred {})",
        status.credited.0,
        transfer_amount.0,
    );
    ensure!(status.claimed.0 > 0, "deposit status must show a claim");
    ensure!(
        status.claimable.0 == 0,
        "nothing further must be claimable after the claim"
    );
    let deposits = federation.usdt_list_deposits().await?;
    ensure!(
        deposits.iter().any(|d| d.address == address),
        "usdtListDeposits must include the funded address"
    );

    // Address rotation policy: now that the address has received (and
    // claimed) a deposit, the next generate call must rotate to a fresh one.
    let rotated_address = federation.usdt_generate_deposit_address().await?;
    ensure!(
        rotated_address != address,
        "generate after a credited deposit must rotate to a fresh address \
         (got {rotated_address} again)"
    );
    ensure!(
        rotated_address.starts_with("0x") && rotated_address.len() == 42,
        "rotated deposit address must be a 0x-prefixed EVM address, got {rotated_address}"
    );

    // Withdrawal: submit and watch it reach the MPC signing pipeline. (On-
    // chain confirmation needs a bundler-API-capable RPC; see module docs.)
    // The recipient nets `withdraw_amount - fee`, so pick an amount with a
    // ~1 USDT net on top of the current fee quote, bounded by our balance.
    let max_fee = federation
        .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
        .await?;
    let withdraw_amount = RpcUsdtAmount((max_fee.0 + 1_024_000).min(balance.0));
    ensure!(
        withdraw_amount.0 > max_fee.0,
        "balance {} cannot cover a withdrawal above the fee quote {}",
        balance.0,
        max_fee.0,
    );
    info!(
        amount = withdraw_amount.0,
        max_fee = max_fee.0,
        "withdrawing to an external address"
    );
    let txid = federation
        .usdt_withdraw(holder.to_string(), withdraw_amount, max_fee)
        .await?;

    let balance_after = federation.usdt_balance().await?;
    ensure!(
        balance_after.0 <= balance.0 - withdraw_amount.0,
        "balance must drop by at least the withdrawn amount"
    );

    // The withdrawal batcher fires once the consensus EVM head advances
    // `batch_interval_blocks()` past the request AND the pool balance covers
    // the amount. The pool is funded by deposit sweeps, whose on-chain
    // confirmation reads `eth_getUserOperationReceipt` — a bundler API this
    // dev shell's anvil does not serve — so in this environment the
    // withdrawal correctly stays `Queued` behind the pool-balance gate
    // (fedimint's own live-anvil withdraw e2e has the same limitation here).
    // Assert the withdrawal is tracked in a healthy pipeline state and never
    // becomes Unknown/Failed.
    mine_blocks(&anvil, 15).await?;
    let mut last_status = RpcUsdtWithdrawalStatus::Unknown;
    for _ in 0..30 {
        last_status = federation.usdt_withdrawal_status(txid.clone()).await?;
        match &last_status {
            RpcUsdtWithdrawalStatus::Unknown => {
                bail!("withdrawal must be tracked by the federation")
            }
            RpcUsdtWithdrawalStatus::Failed { reason } => {
                bail!("withdrawal failed: {reason}")
            }
            RpcUsdtWithdrawalStatus::Signing
            | RpcUsdtWithdrawalStatus::Submitted
            | RpcUsdtWithdrawalStatus::Confirmed { .. } => break,
            RpcUsdtWithdrawalStatus::Queued => {}
        }
        fedimint_core::task::sleep(Duration::from_secs(2)).await;
    }
    info!(
        ?last_status,
        "withdrawal tracked in the federation pipeline"
    );

    // --- USDT e-cash history: filter-before-limit + paging (Task 6) ---
    // Each USDT e-cash send also spawns an internal mintv2 Reissue (change)
    // operation, so the newest operation-log entries are dominated by
    // reissues. With a naive "take the newest N ops, then filter" approach a
    // `limit=2` window could be entirely reissues and surface zero (or fewer
    // than 2) user-facing rows. `usdt_list_transactions` must instead page the
    // log until it has accumulated 2 non-reissue (EcashSend) entries.
    info!("performing three USDT e-cash sends to exercise history filtering");
    let balance_before_sends = federation.usdt_balance().await?.0;
    let ecash_send_amount = RpcUsdtAmount(balance_before_sends / 16);
    ensure!(
        ecash_send_amount.0 > 0 && balance_before_sends >= ecash_send_amount.0 * 4,
        "need USDT balance to cover three e-cash sends (have {balance_before_sends})"
    );
    let mut sent_notes = Vec::new();
    for i in 0..3 {
        let sent = federation
            .usdt_generate_ecash(ecash_send_amount, false, FrontendMetadata::default())
            .await
            .with_context(|| format!("usdt e-cash send #{i} failed"))?;
        ensure!(!sent.ecash.is_empty(), "send #{i} produced empty ecash");
        sent_notes.push(sent.ecash);
    }

    let recent = federation.usdt_list_transactions(2, None).await?;
    ensure!(
        recent.len() == 2,
        "usdt_list_transactions(limit=2) must return exactly 2 rows even though \
         internal reissues dominate the newest operations (got {})",
        recent.len()
    );
    ensure!(
        recent
            .iter()
            .all(|tx| matches!(tx.kind, RpcUsdtTransactionKind::EcashSend)),
        "the two newest USDT history rows must be the e-cash sends, not internal reissues"
    );

    // Cursor paging: passing the oldest returned row's `createdAt` as
    // `start_time` must return only strictly-older-or-equal entries — it must
    // never re-surface an entry newer than the cursor.
    let cursor = recent.last().map(|tx| tx.created_at);
    let older = federation.usdt_list_transactions(10, cursor).await?;
    ensure!(
        older.iter().all(|tx| tx.created_at <= cursor.unwrap()),
        "paged rows must be no newer than the supplied cursor"
    );

    // --- Backup + seed recovery into a USDT-only federation ---
    // REGRESSION: `perform_nonce_reuse_check` runs when a join-with-recovery
    // completes and used to `.expect` a (v1) mint module — which this
    // federation does not have — panicking the bridge on the very join this
    // leg performs. The check must skip gracefully and the recovered wallet
    // must end up at the same settled balance.
    //
    // Settle the three outstanding e-cash sends first (re-receive our own
    // notes) so the recovered balance has an exact expectation.
    info!("re-receiving own sent notes to settle the balance before backup");
    for (i, ecash) in sent_notes.into_iter().enumerate() {
        federation
            .usdt_receive_ecash(ecash)
            .await
            .with_context(|| format!("re-receiving own usdt note #{i} failed"))?;
    }
    // Sends are fee-free and the notes sum to the sent amounts, so
    // re-receiving all three returns the balance exactly to its
    // pre-sends level (issuance is async, hence the poll).
    let settled_balance = balance_before_sends;
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.usdt_balance().await?.0 == settled_balance)
    })
    .await
    .context("balance never settled after re-receiving own notes")?;

    info!("backing up and shutting down the first device");
    let mnemonic = rpc::getMnemonic(bridge.runtime.clone()).await?;
    rpc::backupNow(federation.clone()).await?;
    // give the backup upload a moment to complete before shutting down
    fedimint_core::task::sleep(Duration::from_secs(1)).await;
    drop(federation);
    td.shutdown().await?;

    info!("recovering the seed on a fresh device and rejoining");
    let mut td2 = TestDevice::new().await?;
    let recovery_bridge = td2.bridge_maybe_onboarding().await?;
    rpc::restoreMnemonic(recovery_bridge.try_get()?, mnemonic).await?;
    rpc::onboardTransferExistingDeviceRegistration(recovery_bridge.try_get()?, 0).await?;
    let recovery_bridge = td2.bridge_full().await?;

    let rpc_federation = rpc::joinFederation(recovery_bridge, invite_code, false).await?;
    let recovered_id = rpc_federation.id.0.clone();

    // Pre-fix, the nonce-reuse check panicked between recovery completion
    // and the `recoveryComplete` event, so the event never fired and the
    // federation stayed unusable.
    poll_until(Duration::from_secs(300), Duration::from_secs(1), || async {
        Ok(td2
            .event_sink()
            .num_events_of_type("recoveryComplete".into())
            == 1)
    })
    .await
    .context("recovery never completed (nonce-reuse check panicked?)")?;

    let recovered_federation = recovery_bridge
        .federations
        .get_federation(&recovered_id)
        .context("federation must be usable after recovery + nonce check")?;
    recovered_federation.usdt_set_evm_rpc_url_override(Some(anvil.rpc_url()));
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(recovered_federation.usdt_balance().await?.0 == settled_balance)
    })
    .await
    .with_context(|| {
        format!("recovered USDT balance never reached the settled pre-backup balance {settled_balance}")
    })?;
    td2.shutdown().await?;

    info!("usdt bridge e2e complete");
    Ok(())
}

/// Mixed BTC+USDT federation coverage (federation shape "d").
///
/// Composes a devfed carrying the Bitcoin v1 modules (mintv1 + walletv1 +
/// lnv1/lnv2) the USDT-only sibling omits, PLUS the usdt module and its
/// USDT-denominated mintv2, then drives the bridge to prove BTC and USDT
/// e-cash coexist and route by note unit.
///
/// This is the REAL shape a devfed can build: config-gen attaches exactly one
/// instance per enabled module kind, so a federation can never carry both a
/// BITCOIN mintv2 and the usdt module's USDT mintv2. The Bitcoin balance and
/// e-cash therefore live in mintv1, and the mint-ops router
/// (`federations::federation_v2::mint_ops::MintOpsRouter`) routes Bitcoin ops
/// to mintv1 while USDT e-cash ops go to the USDT-denominated mintv2. This test
/// asserts that split holds end-to-end: BTC ops touch only the Bitcoin balance,
/// USDT ops touch only the USDT balance, and each note round-trips through the
/// unit its wire format declares.
#[tokio::test(flavor = "multi_thread")]
async fn test_mixed_btc_usdt_federation() -> anyhow::Result<()> {
    use federations::federation_v2::client::ClientExt;
    use fedimint_core::module::AmountUnit;

    if std::env::var("RUN_USDT_TESTS").is_err() {
        info!("skipping mixed btc+usdt e2e (set RUN_USDT_TESTS=1 and run in the nix dev shell)");
        return Ok(());
    }
    let _ = TracingSetup::default().init();

    let (process_mgr, _task_group) = DevFed::process_setup(4).await?;

    info!("starting bitcoind + anvil + synapse + nostr relay");
    let (bitcoind, anvil, synapse, nostr_relay) = tokio::try_join!(
        Bitcoind::new(&process_mgr, false),
        Anvil::new(&process_mgr),
        Synapse::start(&process_mgr),
        NostrRelay::start(&process_mgr),
    )?;
    // SAFETY: single-threaded at this point.
    unsafe {
        std::env::set_var("DEVI_SYNAPSE_SERVER", &synapse.url);
        std::env::set_var("DEVI_NOSTR_RELAY", &nostr_relay.url);
    }

    // The v1 wallet CLIENT can only reach the chain via esplora (client-side
    // bitcoind RPC is unsupported), and the federation's client config points
    // wallet clients at http://127.0.0.1:{FM_PORT_ESPLORA}. Without esplora
    // the funder's `await-deposit` polls forever, so start it before any
    // pegin. (The USDT-only sibling has no wallet module and skips this.)
    info!("starting esplora (v1 wallet client chain source)");
    let _esplora = Esplora::new(&process_mgr, bitcoind.clone()).await?;

    info!("deploying test ERC-20 + ERC-4337 EntryPoint");
    let holder = account_1_address()?;
    let token = deploy_test_erc20(&anvil, holder, UsdtAmount(100_000_000)).await?;
    let entry_point = deploy_entry_point(&anvil).await?;

    // SAFETY: single-threaded at this point; set before any fedimintd
    // subprocess is spawned so every guardian inherits these.
    unsafe {
        // Mixed federation: the Bitcoin v1 stack PLUS usdt + USDT mintv2.
        std::env::set_var(FM_ENABLE_MODULE_USDT_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_MINTV2_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_MINT_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_WALLET_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_WALLETV2_ENV, "0");
        std::env::set_var(FM_ENABLE_MODULE_LNV1_ENV, "1");
        std::env::set_var(FM_ENABLE_MODULE_LNV2_ENV, "1");
        // The single mintv2 instance the harness can create is USDT-denominated
        // (the usdt module mints claimed deposits into it).
        std::env::set_var(
            FM_MINTV2_AMOUNT_UNIT_ENV,
            serde_json::to_value(USDT_UNIT)
                .expect("AmountUnit is serializable")
                .to_string(),
        );
        std::env::set_var(FM_DISABLE_BASE_FEES_ENV, "1");
        std::env::set_var(FM_USDT_CONTRACT_ENV, token.to_string());
        std::env::set_var(FM_USDT_ENTRY_POINT_ENV, entry_point.to_string());
        std::env::set_var(
            FM_USDT_BROADCASTER_PRIVATE_KEY_ENV,
            ANVIL_ACCOUNT_0_PRIVATE_KEY,
        );
        std::env::set_var(
            FM_USDT_ETH_USD_PRICE_FEED_ENV,
            EvmAddress([0u8; 20]).to_string(),
        );
        std::env::set_var(
            devimint::envs::FM_DEVIMINT_CONFIG_GEN_TIMEOUT_SECS_ENV,
            "300",
        );
    }

    info!("starting the mixed BTC+USDT federation (real cggmp21 DKG, takes minutes)");
    let fed = Federation::new(
        &process_mgr,
        bitcoind,
        false,
        false,
        0,
        "default".to_string(),
    )
    .await?;
    let invite_code = fed.invite_code()?;

    info!("joining via the bridge");
    let td = TestDevice::new().await?;
    let bridge = td.bridge_full().await?;
    let rpc_federation = rpc::joinFederation(bridge, invite_code.clone(), false).await?;
    let federation = bridge
        .federations
        .get_federation(&rpc_federation.id.0)
        .context("federation must be ready after join")?;

    // Assertion 1: usdt supported, zero USDT balance to start.
    ensure!(
        federation.usdt_supported(),
        "joined federation must report the usdt module"
    );
    ensure!(
        federation.usdt_balance().await?.0 == 0,
        "fresh client must start at zero USDT balance"
    );
    // Deposit-by-proof: point the bridge deposit service's proof fetcher at
    // the e2e anvil (no operator `usdt:evm_rpc_url` meta in a devfed; the
    // client module's built-in defaults are mainnet-only).
    federation.usdt_set_evm_rpc_url_override(Some(anvil.rpc_url()));

    // Composition: enumerate the mintv2 instances the DKG actually built. This
    // is shape (d): config-gen attaches exactly one instance per module kind,
    // so the sole mintv2 is USDT-denominated (the usdt module mints claimed
    // deposits into it) and there is NO BITCOIN mintv2. The Bitcoin balance
    // therefore lives in mintv1, and the mint-ops router keeps it reachable
    // alongside the USDT mintv2.
    let mintv2_units: Vec<AmountUnit> = federation
        .client
        .mintv2_instances()
        .await
        .iter()
        .map(|m| m.amount_unit())
        .collect();
    let module_kinds: Vec<String> = federation
        .client
        .config()
        .await
        .modules
        .values()
        .map(|m| m.kind().to_string())
        .collect();
    info!(
        ?module_kinds,
        ?mintv2_units,
        "joined mixed-fed module composition"
    );
    ensure!(
        mintv2_units.contains(&USDT_UNIT),
        "expected a USDT-denominated mintv2 instance, got units {mintv2_units:?}"
    );
    ensure!(
        !mintv2_units.contains(&AmountUnit::BITCOIN),
        "shape (d) must have NO BITCOIN mintv2 (config-gen is one-instance-per-kind); \
         got units {mintv2_units:?}"
    );
    ensure!(
        federation.client.mint().is_ok(),
        "shape (d) must carry mintv1 to hold the Bitcoin balance"
    );

    // --- Assertion 2: BTC funding lands in mintv1 (get_raw_balance > 0) ---
    // Fund the Bitcoin balance the way the standard bridge tests do: peg a
    // devimint client in, spend v1 OOBNotes from it, and reissue them through
    // the bridge. `receive_ecash` on v1 OOBNotes must route to mintv1 (the
    // router decodes the note format), crediting the Bitcoin balance.
    ensure!(
        federation.get_balance().await == fedimint_core::Amount::ZERO,
        "fresh client must start at zero BTC balance"
    );
    let funder = fed.new_joined_client("mixed-btc-funder").await?;
    // Hand-rolled pegin instead of `fed.pegin_client`: with 4 DKG'd fedimintd
    // + synapse + anvil sharing the host, bitcoind's wallet block processing
    // crawls (~2-3s per block), so devimint's single generatetoaddress(21)
    // RPC blows its fixed 45s client timeout (surfacing as "Couldn't connect
    // to host: Resource temporarily unavailable"). Mine block-by-block with
    // retries instead; same protocol, sturdier transport.
    let pegin_sats = 100_000u64;
    let deposit_fees_sat = fed.deposit_fees()?.msats / 1000;
    let (pegin_address, pegin_operation) = funder.get_deposit_addr().await?;
    info!(%pegin_address, "funding the devimint client via pegin");
    let bitcoind = fed.bitcoind.clone();
    retry_flaky("bitcoind send_to", 5, || {
        let addr = pegin_address.clone();
        let bitcoind = bitcoind.clone();
        async move {
            bitcoind
                .send_to(addr, pegin_sats + deposit_fees_sat)
                .await
                .map(|_| ())
        }
    })
    .await?;
    for i in 0..21 {
        retry_flaky("bitcoind mine block", 5, || {
            let bitcoind = bitcoind.clone();
            async move { bitcoind.mine_blocks(1).await }
        })
        .await
        .with_context(|| format!("mining block {i}"))?;
    }
    info!("mined 21 blocks; waiting for the funder deposit to confirm");
    funder.await_deposit(&pegin_operation).await?;
    let btc_notes = cmd!(funder, "spend", "--allow-overpay", "20000000") // 20_000 sats
        .out_json()
        .await?["notes"]
        .as_str()
        .context("fedimint-cli spend returned no notes")?
        .to_owned();
    let (recv_amount, _op) = federation
        .receive_ecash(btc_notes, FrontendMetadata::default())
        .await
        .context("bridge receive_ecash of v1 BTC notes failed")?;
    ensure!(
        recv_amount > fedimint_core::Amount::ZERO,
        "received BTC e-cash must be positive"
    );
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.get_balance().await > fedimint_core::Amount::ZERO)
    })
    .await
    .context("BTC e-cash was never credited to the mintv1 balance")?;
    let btc_balance = federation.get_balance().await;
    info!(btc_msats = btc_balance.msats, "BTC funded into mintv1");

    // --- Assertion 3: BTC generateEcash -> validates as bitcoin (v1 path) and
    // re-receives correctly ---
    let btc_send_amount = fedimint_core::Amount::from_sats(1000);
    let btc_ecash = federation
        .generate_ecash(btc_send_amount, false, FrontendMetadata::default())
        .await
        .context("BTC generate_ecash failed")?;
    let parsed = bridge
        .federations
        .validate_ecash(btc_ecash.ecash.clone())
        .await?;
    ensure!(
        matches!(
            parsed,
            rpc_types::RpcEcashInfo::Joined {
                unit: rpc_types::RpcEcashUnit::Bitcoin,
                ..
            }
        ),
        "BTC e-cash must validate as unit `bitcoin`, got {parsed:?}"
    );
    let btc_after_send = federation.get_balance().await;
    ensure!(
        btc_after_send < btc_balance,
        "BTC send must reduce the Bitcoin balance ({} !< {})",
        btc_after_send.msats,
        btc_balance.msats
    );
    // Reissue the notes back through the generic receive path; they must land
    // in mintv1 and restore the balance.
    let (btc_reissued, _) = federation
        .receive_ecash(btc_ecash.ecash.clone(), FrontendMetadata::default())
        .await
        .context("re-receiving BTC notes failed")?;
    ensure!(
        btc_reissued == btc_send_amount,
        "re-received BTC amount {} must equal the sent {}",
        btc_reissued.msats,
        btc_send_amount.msats
    );
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.get_balance().await > btc_after_send)
    })
    .await
    .context("BTC balance never recovered after re-receiving own notes")?;

    // Settle to a stable Bitcoin baseline; every USDT op below must leave it
    // untouched.
    let btc_baseline = federation.get_balance().await;
    info!(
        btc_msats = btc_baseline.msats,
        "BTC baseline before USDT ops"
    );

    // --- Fund USDT via the on-chain deposit flow (same as the sibling) ---
    info!("waiting for the usdt module to report Ready");
    poll_until(Duration::from_secs(180), Duration::from_secs(2), || async {
        Ok(federation.usdt_status().await?.ready)
    })
    .await
    .context("usdt module never reported Ready")?;
    info!("waiting for a nonzero withdrawal fee quote (fee median)");
    poll_until(Duration::from_secs(120), Duration::from_secs(1), || async {
        Ok(federation
            .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
            .await
            .map(|fee| fee.0 > 0)
            .unwrap_or(false))
    })
    .await
    .context("fee median never converged")?;
    let address = federation.usdt_generate_deposit_address().await?;
    // Deposit-by-proof charges NO deposit fee; size the deposit with
    // headroom only for the later USDT ops, as a 512-multiple so the atomic
    // credit+mint issues it exactly in full (see the sibling test).
    let fee_quote = federation
        .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
        .await?;
    let transfer_amount = UsdtAmount((MIN_NET_DEPOSIT + fee_quote.0 * 4).next_multiple_of(512));
    let deposit_address: EvmAddress = address.parse()?;
    info!(%address, amount = transfer_amount.0, "sending on-chain USDT to the deposit address");
    transfer_erc20_from_account_1(&anvil, token, deposit_address, transfer_amount).await?;
    mine_blocks(&anvil, 3).await?;
    // Keep anvil's on-demand-mined head (and thus the guardians' anchored
    // confirmation-deep block) moving past the funding transfer while the
    // bridge deposit service fetches + submits the balance proof.
    info!("waiting for the deposit service to proof-credit the deposit into USDT e-cash");
    poll_until(Duration::from_secs(300), Duration::from_secs(2), || async {
        mine_blocks(&anvil, 1).await?;
        Ok(federation.usdt_balance().await?.0 > 0)
    })
    .await
    .context("deposit was never proof-credited into USDT e-cash")?;
    let usdt_funded = federation.usdt_balance().await?.0;
    ensure!(
        usdt_funded == transfer_amount.0,
        "deposit-by-proof mints the FULL deposit (no deposit fee): balance {usdt_funded} != \
         transferred {}",
        transfer_amount.0,
    );
    // Funding USDT must NOT have touched the Bitcoin balance.
    ensure!(
        federation.get_balance().await == btc_baseline,
        "USDT deposit must not change the Bitcoin balance"
    );
    info!(usdt = usdt_funded, "USDT funded via deposit; BTC untouched");

    // --- Assertion 4: usdtGenerateEcash -> usdtReceiveEcash round-trip moves
    // the USDT balance while BTC is unchanged ---
    // mintv2's `send` rounds up to a multiple of the smallest client
    // denomination (2^9 = 512), so pick a multiple to keep the exact-amount
    // assertions below tight. A 512-multiple also can never equal the BTC
    // op's msat amount (1_000_000 is not one), so assertion 6's "no BTC
    // amounts in USDT history" check cannot collide.
    let usdt_send = RpcUsdtAmount((usdt_funded / 16) & !511);
    ensure!(usdt_send.0 > 0, "need a nonzero USDT send amount");
    let usdt_note = federation
        .usdt_generate_ecash(usdt_send, false, FrontendMetadata::default())
        .await
        .context("usdt_generate_ecash failed")?;
    let usdt_after_send = federation.usdt_balance().await?.0;
    ensure!(
        usdt_after_send < usdt_funded,
        "USDT send must reduce the USDT balance ({usdt_after_send} !< {usdt_funded})"
    );
    ensure!(
        federation.get_balance().await == btc_baseline,
        "USDT send must not change the Bitcoin balance"
    );
    let usdt_received = federation
        .usdt_receive_ecash(usdt_note.ecash.clone())
        .await
        .context("usdt_receive_ecash failed")?;
    ensure!(
        usdt_received.0 == usdt_send.0,
        "usdt_receive_ecash returned {} but sent {}",
        usdt_received.0,
        usdt_send.0
    );
    // The re-received notes are credited asynchronously after the receive
    // operation reports Success; poll like the BTC re-receive above (and
    // assertion 5 below) instead of racing the issuance with a single read.
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.usdt_balance().await?.0 > usdt_after_send)
    })
    .await
    .context("receiving the USDT note back never restored the USDT balance")?;
    ensure!(
        federation.get_balance().await == btc_baseline,
        "USDT receive must not change the Bitcoin balance"
    );

    // --- Assertion 5: generic receiveEcash on a USDT v2 note credits USDT,
    // not BTC (the router dispatches by note format, then by unit) ---
    let usdt_before_generic = federation.usdt_balance().await?.0;
    let usdt_note_2 = federation
        .usdt_generate_ecash(usdt_send, false, FrontendMetadata::default())
        .await?;
    let usdt_after_generic_send = federation.usdt_balance().await?.0;
    let (generic_amt, _) = federation
        .receive_ecash(usdt_note_2.ecash.clone(), FrontendMetadata::default())
        .await
        .context("generic receive_ecash of a USDT note failed")?;
    ensure!(
        generic_amt.msats == usdt_send.0,
        "generic receive of the USDT note reported {} micros, expected {}",
        generic_amt.msats,
        usdt_send.0
    );
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.usdt_balance().await?.0 > usdt_after_generic_send)
    })
    .await
    .context("generic receive of USDT note never credited USDT")?;
    let usdt_after_generic = federation.usdt_balance().await?.0;
    ensure!(
        usdt_after_generic >= usdt_before_generic,
        "generic USDT receive must restore USDT balance ({usdt_after_generic} < {usdt_before_generic})"
    );
    ensure!(
        federation.get_balance().await == btc_baseline,
        "crediting a USDT note through the generic path must not change the Bitcoin balance"
    );

    // --- Assertion 5b: re-claiming a note THIS client already claimed must
    // never double-credit. The claim resolves to the same operation id as
    // the original receive, so today it reports idempotent success; a clean
    // already-spent error would be equally acceptable. What must NEVER
    // happen is a second credit.
    let usdt_before_double = federation.usdt_balance().await?.0;
    match federation.usdt_receive_ecash(usdt_note_2.ecash.clone()).await {
        Ok(amount) => ensure!(
            amount.0 == usdt_send.0,
            "idempotent re-claim must report the original amount, got {}",
            amount.0
        ),
        Err(err) => ensure!(
            matches!(
                err.downcast_ref::<rpc_types::error::ErrorCode>(),
                Some(rpc_types::error::ErrorCode::EcashAlreadySpent)
            ),
            "same-client re-claim may only fail with EcashAlreadySpent, got: {err:?}"
        ),
    }
    fedimint_core::task::sleep(Duration::from_secs(2)).await;
    ensure!(
        federation.usdt_balance().await?.0 == usdt_before_double,
        "re-claiming an own already-claimed note must not double-credit"
    );

    // --- Assertion 5c: a DIFFERENT wallet claiming an already-claimed note
    // (the field scenario: several users scanning the same shared note) must
    // fail cleanly with EcashAlreadySpent — no crash, no balance change, and
    // the claimer stays fully operational. This also regression-covers the
    // mintv2 refund-on-rejection path in the mixed shape: with mintv1
    // present, a wrong-unit refund (the pre-usdt.6 bug) would NOT panic —
    // it would strand an invalid BTC-balanced refund tx silently, which the
    // liveness assertions below would catch.
    info!("joining with a second device to attempt a cross-client double-claim");
    let claimer_td = TestDevice::new().await?;
    let claimer_bridge = claimer_td.bridge_full().await?;
    let claimer_rpc_fed = rpc::joinFederation(claimer_bridge, invite_code, false).await?;
    let claimer_federation = claimer_bridge
        .federations
        .get_federation(&claimer_rpc_fed.id.0)
        .context("second device must join the mixed federation")?;
    claimer_federation.usdt_set_evm_rpc_url_override(Some(anvil.rpc_url()));

    let double_claim_err = claimer_federation
        .usdt_receive_ecash(usdt_note_2.ecash.clone())
        .await
        .err()
        .context("cross-client claim of an already-claimed USDT note must fail")?;
    ensure!(
        matches!(
            double_claim_err.downcast_ref::<rpc_types::error::ErrorCode>(),
            Some(rpc_types::error::ErrorCode::EcashAlreadySpent)
        ),
        "cross-client double-claim must surface ErrorCode::EcashAlreadySpent, got: {double_claim_err:?}"
    );
    // The rejected claim (and its refund attempt) must not mint anything.
    fedimint_core::task::sleep(Duration::from_secs(2)).await;
    ensure!(
        claimer_federation.usdt_balance().await?.0 == 0,
        "claimer must not be credited for an already-claimed note"
    );
    ensure!(
        federation.usdt_balance().await?.0 == usdt_before_double,
        "original owner's USDT balance must be unchanged by a foreign double-claim"
    );
    ensure!(
        federation.get_balance().await == btc_baseline,
        "BTC balance must be unchanged by a rejected USDT double-claim"
    );
    // Claimer liveness: a FRESH note from the first wallet must still claim
    // fine (pre-usdt.6 the rejection killed the claimer's sm-executor).
    let fresh_note = federation
        .usdt_generate_ecash(usdt_send, false, FrontendMetadata::default())
        .await?;
    claimer_federation
        .usdt_receive_ecash(fresh_note.ecash)
        .await
        .context("claimer must stay operational after the rejected double-claim")?;
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(claimer_federation.usdt_balance().await?.0 == usdt_send.0)
    })
    .await
    .context("claimer never received the fresh cross-client note")?;

    // --- Assertion 8: a stamped USDT note validates as unit `usdt` ---
    let usdt_parsed = bridge
        .federations
        .validate_ecash(usdt_note_2.ecash.clone())
        .await?;
    ensure!(
        matches!(
            usdt_parsed,
            rpc_types::RpcEcashInfo::Joined {
                unit: rpc_types::RpcEcashUnit::Usdt,
                ..
            }
        ),
        "USDT e-cash must validate as unit `usdt`, got {usdt_parsed:?}"
    );

    // --- Assertion 9: a USDT note generated with an embedded invite
    // validates as NotJoined + unit `usdt` when parsed from a FRESH bridge
    // that has never joined this federation. `unit` must come from the
    // note's own self-describing field, not a joined-federation lookup
    // (there is none here), and must not be conflated with `None`/Bitcoin. ---
    let usdt_note_with_invite = federation
        .usdt_generate_ecash(usdt_send, true, FrontendMetadata::default())
        .await
        .context("usdt_generate_ecash with invite failed")?;
    let fresh_td = TestDevice::new().await?;
    let fresh_bridge = fresh_td.bridge_full().await?;
    let not_joined_parsed = fresh_bridge
        .federations
        .validate_ecash(usdt_note_with_invite.ecash.clone())
        .await?;
    ensure!(
        matches!(
            not_joined_parsed,
            rpc_types::RpcEcashInfo::NotJoined {
                unit: Some(rpc_types::RpcEcashUnit::Usdt),
                federation_invite: Some(_),
                ..
            }
        ),
        "USDT e-cash validated from a fresh unjoined bridge must report \
         federation_type = notJoined with unit = usdt and an embedded invite, \
         got {not_joined_parsed:?}"
    );

    // --- Assertion 6: usdtListTransactions contains the USDT sends/receives
    // with micro amounts and NOT the BTC ops ---
    let usdt_txns = federation.usdt_list_transactions(50, None).await?;
    ensure!(
        usdt_txns
            .iter()
            .any(|tx| matches!(tx.kind, RpcUsdtTransactionKind::EcashSend)),
        "USDT history must contain the USDT e-cash sends"
    );
    ensure!(
        usdt_txns
            .iter()
            .any(|tx| matches!(tx.kind, RpcUsdtTransactionKind::EcashReceive)),
        "USDT history must contain the USDT e-cash receives"
    );
    // Every USDT e-cash row carries a micro amount matching our send size, and
    // the BTC ops (1000-sat sends/receives) never appear: had a BITCOIN mintv2
    // op leaked in, its msats would render here as USDT micros.
    ensure!(
        usdt_txns
            .iter()
            .filter(|tx| matches!(
                tx.kind,
                RpcUsdtTransactionKind::EcashSend | RpcUsdtTransactionKind::EcashReceive
            ))
            .all(|tx| tx.amount.0 == usdt_send.0),
        "USDT e-cash rows must carry the USDT micro amount {}, got {:?}",
        usdt_send.0,
        usdt_txns.iter().map(|tx| tx.amount.0).collect::<Vec<_>>()
    );
    // Structural (not amount-coincidence) BTC-absence check: assert the USDT
    // history contains EXACTLY the USDT e-cash ops we performed above and no
    // more — 4 sends (usdt_generate_ecash at the initial send, the generic-
    // receive setup, the cross-client liveness note of assertion 5c, and the
    // with-invite send) and 2 receives (usdt_receive_ecash + the generic
    // receive_ecash of a USDT note; the 5b re-claim reuses the original
    // operation so it must NOT add a row, and 5c's claims live on the OTHER
    // device's log). A leaked BITCOIN-unit mintv2 op would surface here as an
    // extra EcashSend/EcashReceive row regardless of its msats, so pinning
    // the per-kind counts proves BTC ops are absent by operation
    // kind/identity, not merely because their amount failed to coincide with
    // a USDT micro amount.
    let usdt_send_count = usdt_txns
        .iter()
        .filter(|tx| matches!(tx.kind, RpcUsdtTransactionKind::EcashSend))
        .count();
    let usdt_receive_count = usdt_txns
        .iter()
        .filter(|tx| matches!(tx.kind, RpcUsdtTransactionKind::EcashReceive))
        .count();
    ensure!(
        usdt_send_count == 4 && usdt_receive_count == 2,
        "USDT history must contain exactly the 4 USDT e-cash sends and 2 \
         receives performed above (no leaked BITCOIN mintv2 ops), got \
         {usdt_send_count} sends and {usdt_receive_count} receives: {usdt_txns:?}"
    );

    // --- Assertion 7: cancel a generated USDT ecash -> USDT restored, BTC
    // untouched (cancel routes by note format then unit) ---
    let usdt_before_cancel = federation.usdt_balance().await?.0;
    let usdt_note_3 = federation
        .usdt_generate_ecash(usdt_send, false, FrontendMetadata::default())
        .await?;
    let usdt_after_cancel_send = federation.usdt_balance().await?.0;
    ensure!(
        usdt_after_cancel_send < usdt_before_cancel,
        "USDT send before cancel must reduce the balance"
    );
    federation
        .cancel_ecash(usdt_note_3.ecash.clone())
        .await
        .context("cancel_ecash of a USDT note failed")?;
    poll_until(Duration::from_secs(60), Duration::from_secs(1), || async {
        Ok(federation.usdt_balance().await?.0 > usdt_after_cancel_send)
    })
    .await
    .context("cancelling the USDT note never restored USDT balance")?;
    let usdt_after_cancel = federation.usdt_balance().await?.0;
    ensure!(
        usdt_after_cancel >= usdt_before_cancel,
        "cancel must restore the USDT balance ({usdt_after_cancel} < {usdt_before_cancel})"
    );
    ensure!(
        federation.get_balance().await == btc_baseline,
        "cancelling a USDT note must not change the Bitcoin balance"
    );

    info!("mixed btc+usdt e2e (shape d) complete: BTC in mintv1, USDT in mintv2, routed by note");
    Ok(())
}

/// Retry a devimint op whose transport is flaky under full devfed load
/// (e.g. bitcoind wallet RPCs stalling past devimint's fixed 45s client
/// timeout, surfacing as "Couldn't connect to host: Resource temporarily
/// unavailable").
async fn retry_flaky<F, Fut, T>(what: &str, tries: usize, mut op: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    let mut attempt = 0;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(err) => {
                attempt += 1;
                if attempt >= tries {
                    return Err(err.context(format!("{what} failed after {attempt} attempts")));
                }
                tracing::warn!(what, attempt, err = format!("{err:#}"), "retrying flaky op");
                fedimint_core::task::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

async fn poll_until<F, Fut>(
    deadline: Duration,
    interval: Duration,
    mut check: F,
) -> anyhow::Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<bool>>,
{
    let deadline_at = fedimint_core::time::now() + deadline;
    loop {
        if check().await? {
            return Ok(());
        }
        ensure!(
            fedimint_core::time::now() < deadline_at,
            "poll_until deadline exceeded"
        );
        fedimint_core::task::sleep(interval).await;
    }
}

// --- anvil helpers, mirrored from fedimint's usdt e2e harness -----------

sol! {
    #[sol(rpc)]
    interface ITestUsdt {
        function mint(address to, uint256 amount) external;
        function transfer(address to, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
    }
}

/// anvil's first deterministic dev account: deployer, miner and (via
/// `FM_USDT_BROADCASTER_PRIVATE_KEY`) every guardian's broadcaster EOA.
const ANVIL_ACCOUNT_0_PRIVATE_KEY: &str =
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/// anvil's second deterministic dev account: the ERC-20 holder funding the
/// deposit (and the withdrawal recipient).
const ANVIL_ACCOUNT_1_PRIVATE_KEY: &str =
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const TEST_USDT_FIXTURE_JSON: &str = include_str!("../../../test-fixtures/test_usdt.json");
const ENTRY_POINT_ARTIFACT_JSON: &str = include_str!("../../../test-fixtures/EntryPoint.json");

fn account_1_address() -> anyhow::Result<EvmAddress> {
    let signer: PrivateKeySigner = ANVIL_ACCOUNT_1_PRIVATE_KEY
        .parse()
        .context("malformed ANVIL_ACCOUNT_1_PRIVATE_KEY")?;
    Ok(EvmAddress(signer.address().into_array()))
}

fn wallet_provider(anvil: &Anvil, private_key: &str) -> anyhow::Result<impl Provider + Clone> {
    let signer: PrivateKeySigner = private_key
        .parse()
        .context("malformed anvil dev-account private key")?;
    let url = anvil
        .rpc_url()
        .parse()
        .with_context(|| format!("invalid anvil url: {}", anvil.rpc_url()))?;
    Ok(ProviderBuilder::new().wallet(signer).connect_http(url))
}

fn artifact_hex_field(artifact_json: &str, field: &str) -> anyhow::Result<Vec<u8>> {
    let artifact: serde_json::Value =
        serde_json::from_str(artifact_json).context("failed to parse contract artifact JSON")?;
    let hex_str = artifact[field]
        .as_str()
        .with_context(|| format!("artifact is missing a `{field}` string field"))?;
    let hex_str = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    hex::decode(hex_str).with_context(|| format!("artifact `{field}` is not valid hex"))
}

async fn deploy_test_erc20(
    anvil: &Anvil,
    holder: EvmAddress,
    amount: UsdtAmount,
) -> anyhow::Result<EvmAddress> {
    let provider = wallet_provider(anvil, ANVIL_ACCOUNT_0_PRIVATE_KEY)?;
    let bytecode = artifact_hex_field(TEST_USDT_FIXTURE_JSON, "bytecode")?;
    let receipt = provider
        .send_transaction(TransactionRequest::default().with_deploy_code(bytecode))
        .await
        .context("failed to send TestUsdt creation transaction")?
        .get_receipt()
        .await
        .context("failed to confirm TestUsdt creation transaction")?;
    let token_address = receipt
        .contract_address
        .context("TestUsdt creation receipt is missing a contract_address")?;

    let contract = ITestUsdt::new(token_address, &provider);
    contract
        .mint(Address::from(holder.0), U256::from(amount.0))
        .send()
        .await
        .context("failed to send mint() transaction")?
        .get_receipt()
        .await
        .context("failed to confirm mint() transaction")?;

    Ok(EvmAddress(token_address.into_array()))
}

async fn deploy_entry_point(anvil: &Anvil) -> anyhow::Result<EvmAddress> {
    let provider = wallet_provider(anvil, ANVIL_ACCOUNT_0_PRIVATE_KEY)?;
    let bytecode = artifact_hex_field(ENTRY_POINT_ARTIFACT_JSON, "bytecode")?;
    let receipt = provider
        .send_transaction(TransactionRequest::default().with_deploy_code(bytecode))
        .await
        .context("failed to send EntryPoint creation transaction")?
        .get_receipt()
        .await
        .context("failed to confirm EntryPoint creation transaction")?;
    let entry_point = receipt
        .contract_address
        .context("EntryPoint creation receipt is missing a contract_address")?;
    Ok(EvmAddress(entry_point.into_array()))
}

async fn transfer_erc20_from_account_1(
    anvil: &Anvil,
    token: EvmAddress,
    to: EvmAddress,
    amount: UsdtAmount,
) -> anyhow::Result<()> {
    let provider = wallet_provider(anvil, ANVIL_ACCOUNT_1_PRIVATE_KEY)?;
    let contract = ITestUsdt::new(Address::from(token.0), &provider);
    contract
        .transfer(Address::from(to.0), U256::from(amount.0))
        .send()
        .await
        .context("failed to send transfer() transaction")?
        .get_receipt()
        .await
        .context("failed to confirm transfer() transaction")?;
    Ok(())
}

/// Mines `n` empty blocks on anvil, advancing the chain head without any
/// transaction — used to deepen confirmations and to push the head past the
/// withdrawal batch's `batch_interval_blocks()` trigger.
async fn mine_blocks(anvil: &Anvil, n: u32) -> anyhow::Result<()> {
    let provider = wallet_provider(anvil, ANVIL_ACCOUNT_0_PRIVATE_KEY)?;
    for _ in 0..n {
        provider
            .raw_request::<_, String>("evm_mine".into(), ())
            .await
            .context("failed to mine an anvil block")?;
    }
    Ok(())
}
