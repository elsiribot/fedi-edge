import { useCallback, useEffect } from 'react'

import {
    refreshUsdtBalance,
    selectCurrencyLocale,
    selectUsdtBalanceMicros,
} from '../redux'
import { Federation } from '../types'
import amountUtils from '../utils/AmountUtils'
import { makeLog } from '../utils/log'
import { formatUsdtMicros } from '../utils/usdt'
import { useIsUsdtSupported } from './federation'
import { useFedimint } from './fedimint'
import { useCommonDispatch, useCommonSelector } from './redux'

const log = makeLog('common/hooks/usdt')

/**
 * Returns the decimal separator (e.g. `.` for en-US, `,` for de-DE) that a
 * USDT amount-entry field's numpad should insert for the user's currency
 * locale, and that callers should pass to `parseUsdtInput` when parsing
 * that field's raw text. Mirrors the locale handling `useAmountInput` does
 * for BTC/fiat amount entry so USDT input follows the same conventions.
 */
export const useUsdtDecimalSeparator = (): string => {
    const currencyLocale = useCommonSelector(selectCurrencyLocale)
    return amountUtils.getDecimalSeparator({ locale: currencyLocale })
}

/**
 * Returns the grouping (thousands) separator (e.g. `,` for en-US, `.` for
 * de-DE, the narrow no-break space U+202F for fr-FR) for the user's
 * currency locale, for passing to `parseUsdtInput`'s `groupingSeparator`
 * option alongside `useUsdtDecimalSeparator`'s decimal separator, so the
 * parser can always re-parse `formatUsdtMicros`' own grouped output.
 */
export const useUsdtGroupingSeparator = (): string => {
    const currencyLocale = useCommonSelector(selectCurrencyLocale)
    return amountUtils.getThousandsSeparator({ locale: currencyLocale })
}

/**
 * Returns a `formatUsdtMicros` bound to the user's currency locale
 * (`selectCurrencyLocale`) - the same locale source `useUsdtDecimalSeparator`
 * uses for the numpad/parser - so USDT amount displays never drift from the
 * input's locale. Use this at every React (screen/component/hook) call site
 * that displays a USDT amount; `formatUsdtMicros` itself stays locale-less
 * for non-React contexts, where it mirrors how the BTC path formats amounts
 * in that same context (see `utils/matrix.ts`/`redux/matrix.ts`).
 */
export const useFormatUsdtMicros = () => {
    const currencyLocale = useCommonSelector(selectCurrencyLocale)
    return useCallback(
        (micros: number, opts: { symbol?: boolean } = {}) =>
            formatUsdtMicros(micros, { ...opts, locale: currencyLocale }),
        [currencyLocale],
    )
}

export const useUsdtBalance = (federationId: Federation['id']) => {
    const dispatch = useCommonDispatch()
    const fedimint = useFedimint()
    const formatUsdt = useFormatUsdtMicros()
    const balanceMicros = useCommonSelector(s =>
        selectUsdtBalanceMicros(s, federationId),
    )

    const refreshBalance = useCallback(() => {
        dispatch(refreshUsdtBalance({ fedimint, federationId }))
    }, [dispatch, fedimint, federationId])

    return {
        balanceMicros,
        formattedBalance: formatUsdt(balanceMicros),
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
