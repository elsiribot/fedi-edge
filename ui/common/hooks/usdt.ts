import { useCallback, useEffect } from 'react'

import { refreshUsdtBalance, selectUsdtBalanceMicros } from '../redux'
import { Federation } from '../types'
import { makeLog } from '../utils/log'
import { formatUsdtMicros } from '../utils/usdt'
import { useIsUsdtSupported } from './federation'
import { useFedimint } from './fedimint'
import { useCommonDispatch, useCommonSelector } from './redux'

const log = makeLog('common/hooks/usdt')

export const useUsdtBalance = (federationId: Federation['id']) => {
    const dispatch = useCommonDispatch()
    const fedimint = useFedimint()
    const balanceMicros = useCommonSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const refreshBalance = useCallback(() => {
        dispatch(refreshUsdtBalance({ fedimint, federationId }))
    }, [dispatch, fedimint, federationId])

    return {
        balanceMicros,
        formattedBalance: formatUsdtMicros(balanceMicros),
        refreshBalance,
    }
}

/**
 * Monitors the USDT account of a federation to refresh the balance:
 * - on mount, then every 60 seconds
 * - whenever a USDT deposit or withdrawal event is received
 */
export function useMonitorUsdtAccount(federationId: Federation['id']) {
    const dispatch = useCommonDispatch()
    const fedimint = useFedimint()
    const isUsdtSupported = useIsUsdtSupported(federationId || '')

    useEffect(() => {
        if (!federationId || !isUsdtSupported) return

        log.info('Monitoring USDT account for federation', { federationId })

        const refreshBalance = () =>
            dispatch(refreshUsdtBalance({ fedimint, federationId }))

        refreshBalance()
        const usdtBalanceMonitor = setInterval(refreshBalance, 60000)

        const unsubscribeDeposits = fedimint.addListener(
            'usdtDeposit',
            event => {
                if (event.federationId !== federationId) return
                log.info('UsdtDepositEvent', event.state)
                refreshBalance()
            },
        )
        const unsubscribeWithdrawals = fedimint.addListener(
            'usdtWithdrawal',
            event => {
                if (event.federationId !== federationId) return
                log.info('UsdtWithdrawalEvent', event.state)
                refreshBalance()
            },
        )

        return () => {
            unsubscribeDeposits()
            unsubscribeWithdrawals()
            clearInterval(usdtBalanceMonitor)
        }
    }, [dispatch, fedimint, federationId, isUsdtSupported])
}
