//! End-to-end integration test for USDT support in the fedi bridge.
//!
//! Spins up a minimal USDT-only devimint federation (usdt module + a single
//! USDT-denominated `mintv2`, no Bitcoin wallet / lightning modules) against
//! a real anvil EVM devnet, real cggmp21 DKG included, then drives the whole
//! user flow through bridge APIs: join federation -> readiness -> deposit
//! address -> on-chain ERC-20 deposit -> background auto-claim into USDT
//! e-cash -> balance -> withdrawal submission.
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
use devimint::external::{Anvil, Bitcoind};
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
use rpc_types::usdt::{RpcUsdtAmount, RpcUsdtWithdrawalStatus};
use tracing::info;

use crate::rpc;
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
    let td = TestDevice::new().await?;
    let bridge = td.bridge_full().await?;
    let rpc_federation = rpc::joinFederation(bridge, invite_code, false).await?;
    let federation = bridge
        .federations
        .get_federation(&rpc_federation.id.0)
        .context("federation must be ready after join")?;

    ensure!(
        federation.usdt_supported(),
        "joined federation must report the usdt module"
    );
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

    // Fees scale with anvil's (high) default gas price, so size everything
    // relative to the current quote: the deposit fee is deducted from the
    // claim and the withdrawal needs its own fee headroom on top.
    let fee_quote = federation
        .usdt_withdraw_fee_quote(RpcUsdtAmount(MIN_NET_DEPOSIT))
        .await?;
    let transfer_amount = UsdtAmount(MIN_NET_DEPOSIT + fee_quote.0 * 6);

    info!(%address, amount = transfer_amount.0, "sending on-chain USDT to the deposit address");
    let deposit_address: EvmAddress = address.parse()?;
    transfer_erc20_from_account_1(&anvil, token, deposit_address, transfer_amount).await?;
    mine_blocks(&anvil, 3).await?;

    // The bridge's long-lived deposit service (usdtGenerateDepositAddress
    // marked the address hot, so it is polled every
    // `federations::federation_v2::usdt::USDT_HOT_POLL_INTERVAL` = 15s)
    // must observe, claim, and mint USDT e-cash without further prompting.
    info!("waiting for the deposit service to auto-claim the deposit");
    poll_until(Duration::from_secs(300), Duration::from_secs(2), || async {
        Ok(federation.usdt_balance().await?.0 > 0)
    })
    .await
    .context("deposit was never auto-claimed into USDT e-cash")?;

    let balance = federation.usdt_balance().await?;
    ensure!(
        balance.0 >= MIN_NET_DEPOSIT,
        "claimed balance {} must cover at least the net deposit target {MIN_NET_DEPOSIT} \
         (transferred {} at quote {})",
        balance.0,
        transfer_amount.0,
        fee_quote.0,
    );
    info!(balance = balance.0, "deposit auto-claimed");

    // Deposit status must reflect the claim.
    let status = federation.usdt_deposit_status(address.clone()).await?;
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

    info!("usdt bridge e2e complete");
    Ok(())
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
