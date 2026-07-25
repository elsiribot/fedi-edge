use fedimint_client::module::ClientModule;
use fedimint_client::{Client, ClientModuleInstance};
use fedimint_core::module::AmountUnit;
use fedimint_ln_client::LightningClientModule;
use fedimint_lnv2_client::LightningClientModule as LightningV2ClientModule;
use fedimint_mint_client::MintClientModule;
use fedimint_mintv2_client::MintClientModule as MintV2ClientModule;
use fedimint_usdt_client::UsdtClientModule;
use fedimint_wallet_client::WalletClientModule;
use fedimint_walletv2_client::WalletClientModule as WalletV2ClientModule;
use stability_pool_client_old::StabilityPoolClientModule;

/// Helper functions for fedimint_client::Client
pub trait ClientExt {
    /// Attempt to get the first lightning client module instance.
    fn ln(&self) -> anyhow::Result<ClientModuleInstance<'_, LightningClientModule>>;

    /// Attempt to get the first lightning v2 client module instance.
    fn lnv2(&self) -> anyhow::Result<ClientModuleInstance<'_, LightningV2ClientModule>>;

    /// Attempt to get the first wallet client module instance.
    fn wallet(&self) -> anyhow::Result<ClientModuleInstance<'_, WalletClientModule>>;

    /// Attempt to get the first wallet v2 client module instance.
    fn walletv2(&self) -> anyhow::Result<ClientModuleInstance<'_, WalletV2ClientModule>>;

    /// Attempt to get the first stability pool client module instance.
    fn sp(&self) -> anyhow::Result<ClientModuleInstance<'_, StabilityPoolClientModule>>;

    /// Attempt to get the first stability pool v2 client module instance.
    fn spv2(
        &self,
    ) -> anyhow::Result<ClientModuleInstance<'_, stability_pool_client::StabilityPoolClientModule>>;

    /// Attempt to get the first mint (e-cash) client module instance.
    fn mint(&self) -> anyhow::Result<ClientModuleInstance<'_, MintClientModule>>;

    /// The mint v2 client module instance denominating e-cash in `unit`.
    ///
    /// A federation can carry more than one mintv2 instance (e.g. a
    /// BITCOIN-unit mint for its Bitcoin balance plus the usdt module's
    /// USDT-denominated mint), so instance selection is keyed on the amount
    /// unit rather than "the sole instance".
    #[allow(async_fn_in_trait)]
    async fn mintv2_of_unit(
        &self,
        unit: AmountUnit,
    ) -> anyhow::Result<ClientModuleInstance<'_, MintV2ClientModule>>;

    /// All mint v2 client module instances of this federation, in ascending
    /// instance-id order.
    #[allow(async_fn_in_trait)]
    async fn mintv2_instances(&self) -> Vec<ClientModuleInstance<'_, MintV2ClientModule>>;

    /// Attempt to get the first usdt client module instance.
    fn usdt(&self) -> anyhow::Result<ClientModuleInstance<'_, UsdtClientModule>>;
}

impl ClientExt for Client {
    fn ln(&self) -> anyhow::Result<ClientModuleInstance<'_, LightningClientModule>> {
        self.get_first_module::<LightningClientModule>()
    }

    fn lnv2(&self) -> anyhow::Result<ClientModuleInstance<'_, LightningV2ClientModule>> {
        self.get_first_module::<LightningV2ClientModule>()
    }

    fn wallet(&self) -> anyhow::Result<ClientModuleInstance<'_, WalletClientModule>> {
        self.get_first_module::<WalletClientModule>()
    }

    fn walletv2(&self) -> anyhow::Result<ClientModuleInstance<'_, WalletV2ClientModule>> {
        self.get_first_module::<WalletV2ClientModule>()
    }

    fn sp(&self) -> anyhow::Result<ClientModuleInstance<'_, StabilityPoolClientModule>> {
        self.get_first_module::<StabilityPoolClientModule>()
    }

    fn spv2(
        &self,
    ) -> anyhow::Result<ClientModuleInstance<'_, stability_pool_client::StabilityPoolClientModule>>
    {
        self.get_first_module::<stability_pool_client::StabilityPoolClientModule>()
    }

    fn mint(&self) -> anyhow::Result<ClientModuleInstance<'_, MintClientModule>> {
        self.get_first_module::<MintClientModule>()
    }

    async fn mintv2_of_unit(
        &self,
        unit: AmountUnit,
    ) -> anyhow::Result<ClientModuleInstance<'_, MintV2ClientModule>> {
        let instance_ids: Vec<_> = self
            .config()
            .await
            .modules
            .iter()
            .filter(|(_, module)| module.is_kind(&MintV2ClientModule::kind()))
            .map(|(id, _)| *id)
            .collect();
        for id in instance_ids {
            let instance = self.get_module_by_instance::<MintV2ClientModule>(id)?;
            if instance.amount_unit() == unit {
                return Ok(instance);
            }
        }
        anyhow::bail!("no mintv2 instance with unit {unit:?}")
    }

    async fn mintv2_instances(&self) -> Vec<ClientModuleInstance<'_, MintV2ClientModule>> {
        let instance_ids: Vec<_> = self
            .config()
            .await
            .modules
            .iter()
            .filter(|(_, module)| module.is_kind(&MintV2ClientModule::kind()))
            .map(|(id, _)| *id)
            .collect();
        instance_ids
            .into_iter()
            .filter_map(|id| self.get_module_by_instance::<MintV2ClientModule>(id).ok())
            .collect()
    }

    fn usdt(&self) -> anyhow::Result<ClientModuleInstance<'_, UsdtClientModule>> {
        self.get_first_module::<UsdtClientModule>()
    }
}
