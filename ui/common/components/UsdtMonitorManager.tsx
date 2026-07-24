import { useCommonSelector } from '../hooks/redux'
import { useMonitorUsdtAccount } from '../hooks/usdt'
import { selectLoadedFederationIds } from '../redux'

/**
 * Monitors the USDT account for all loaded federations.
 */
export default function UsdtMonitorManager() {
    const federationIds = useCommonSelector(selectLoadedFederationIds)

    return (
        <>
            {federationIds.map(federationId => (
                <FederationUsdtMonitor
                    key={federationId}
                    federationId={federationId}
                />
            ))}
        </>
    )
}

function FederationUsdtMonitor({ federationId }: { federationId: string }) {
    useMonitorUsdtAccount(federationId)

    return null
}
