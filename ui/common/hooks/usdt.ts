import { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
    refreshUsdtBalance,
    selectCurrencyLocale,
    selectUsdtBalanceMicros,
} from '../redux'
import { Federation } from '../types'
import amountUtils from '../utils/AmountUtils'
import { makeLog } from '../utils/log'
import {
    formatUsdtMicros,
    microsToDecimalString,
    parseUsdtInput,
    USDT_ENTRY_MAX_DECIMALS,
    USDT_MICROS_PER_USDT,
} from '../utils/usdt'
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
        (
            micros: number,
            opts: { symbol?: boolean; rounding?: 'down' | 'up' } = {},
        ) => formatUsdtMicros(micros, { ...opts, locale: currencyLocale }),
        [currencyLocale],
    )
}

/**
 * Truncates a USDT micros amount down to whole cents (toward zero), for
 * seeding/reseeding an amount-entry field from a machine-precision source
 * (e.g. a scanned `ethereum:…?amount=` URI parsed at full 6-decimal
 * precision by `parseUsdtRecipientInput`). The UI entry policy caps
 * amounts at cents, so any sub-cent remainder is dropped here rather than
 * shown - the sender then never sends more than was actually scanned,
 * only (at most) a sub-cent shortfall versus the requested amount.
 */
function truncateMicrosToCents(micros: number): number {
    const microsPerCent = USDT_MICROS_PER_USDT / 100
    return Math.trunc(micros / microsPerCent) * microsPerCent
}

/**
 * Owns the shared amount-entry state for the USDT send/receive/chat screens
 * (review M4): the `amountInput` string, its locale-aware parse to micros,
 * and the insufficient-balance/error-text derivation that each of those
 * screens was repeating. Locale threading (decimal + grouping separators)
 * lives here so callers only deal in micros and the raw input string.
 *
 * `getErrorText` takes the screen's own `invalidWhen` gate (which differs -
 * "user typed something unparseable" vs "submit was attempted") so the
 * insufficient-balance branch is shared without changing when the
 * invalid-amount message appears per screen.
 */
export const useUsdtAmountInput = (opts?: {
    /** Balance to compare against for `hasInsufficientBalance` (default 0) */
    balanceMicros?: number
    /** Prefill the field from a micros amount (e.g. a scanned `?amount=`) */
    initialMicros?: number | null
}) => {
    const decimalSeparator = useUsdtDecimalSeparator()
    const groupingSeparator = useUsdtGroupingSeparator()

    const [amountInput, setAmountInput] = useState(() =>
        opts?.initialMicros
            ? microsToDecimalString(
                  truncateMicrosToCents(opts.initialMicros),
              ).replace('.', decimalSeparator)
            : '',
    )

    // Reseed the field from a micros amount (e.g. re-entering a previously
    // requested amount, or a scanned `?amount=` prefill), applying the same
    // locale-aware formatting the `initialMicros` prefill uses. Truncates to
    // cents per the UI entry precision policy - see `truncateMicrosToCents`.
    // Falsy/zero clears the field.
    const setAmountFromMicros = useCallback(
        (micros: number | null) =>
            setAmountInput(
                micros
                    ? microsToDecimalString(
                          truncateMicrosToCents(micros),
                      ).replace('.', decimalSeparator)
                    : '',
            ),
        [decimalSeparator],
    )

    const balanceMicros = opts?.balanceMicros ?? 0

    // `parseUsdtInput` tolerates a transient trailing decimal separator
    // mid-entry, e.g. "5." - `maxDecimals` caps UI entry at cents, so a 3rd
    // typed/pasted decimal digit is rejected (null) rather than truncated
    // silently.
    const amountMicros = parseUsdtInput(amountInput, {
        decimalSeparator,
        groupingSeparator,
        maxDecimals: USDT_ENTRY_MAX_DECIMALS,
    })
    const isPositiveAmount = amountMicros !== null && amountMicros > 0
    const hasInsufficientBalance =
        amountMicros !== null && amountMicros > balanceMicros
    const isAmountValid = isPositiveAmount && !hasInsufficientBalance

    const getErrorText = useCallback(
        (t: TFunction, invalidWhen: boolean): string | null =>
            hasInsufficientBalance
                ? t('feature.usdt.insufficient-balance')
                : invalidWhen
                  ? t('feature.usdt.invalid-amount')
                  : null,
        [hasInsufficientBalance],
    )

    return {
        amountInput,
        setAmountInput,
        setAmountFromMicros,
        amountMicros,
        isPositiveAmount,
        hasInsufficientBalance,
        isAmountValid,
        decimalSeparator,
        groupingSeparator,
        getErrorText,
    }
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
 * How long a pending deposit stays displayed after its last `pending`
 * event. The bridge re-emits `pending` on every hot-address poll (~15s)
 * while the deposit remains uncredited, so a healthy pending deposit
 * refreshes itself well within this window; if the events stop without a
 * `claimed` (e.g. the bridge lost EVM RPC connectivity), the hint expires
 * rather than showing "incoming" forever.
 */
const PENDING_DEPOSIT_EXPIRY_MS = 60_000

/**
 * Total micros of on-chain deposits the bridge has detected for this
 * federation but the federation has not credited yet (bridge `pending`
 * deposit events) - money that is visibly on its way but NOT in the
 * wallet balance. Cleared per address as soon as its deposit is claimed.
 */
export function usePendingUsdtDeposits(federationId: Federation['id']): number {
    const fedimint = useFedimint()
    const [pendingByAddress, setPendingByAddress] = useState<
        Record<string, { amountMicros: number; seenAt: number }>
    >({})

    useEffect(() => {
        if (!federationId) return

        const unsubscribe = fedimint.addListener('usdtDeposit', event => {
            if (event.federationId !== federationId) return
            const state = event.state
            if (state.type === 'pending') {
                setPendingByAddress(prev => ({
                    ...prev,
                    [event.address]: {
                        amountMicros: state.amount,
                        seenAt: Date.now(),
                    },
                }))
            } else if (state.type === 'claimed') {
                setPendingByAddress(prev => {
                    if (!(event.address in prev)) return prev
                    const next = { ...prev }
                    delete next[event.address]
                    return next
                })
            }
        })
        const expiryInterval = setInterval(() => {
            setPendingByAddress(prev => {
                const now = Date.now()
                const fresh = Object.entries(prev).filter(
                    ([, entry]) =>
                        now - entry.seenAt < PENDING_DEPOSIT_EXPIRY_MS,
                )
                return fresh.length === Object.keys(prev).length
                    ? prev
                    : Object.fromEntries(fresh)
            })
        }, 10_000)

        return () => {
            unsubscribe()
            clearInterval(expiryInterval)
        }
    }, [fedimint, federationId])

    return useMemo(
        () =>
            Object.values(pendingByAddress).reduce(
                (sum, entry) => sum + entry.amountMicros,
                0,
            ),
        [pendingByAddress],
    )
}

/**
 * Monitors the USDT account of a federation to refresh the balance:
 * - on mount, then every 60 seconds
 * - whenever a USDT deposit or withdrawal event is received
 * - whenever a transaction event for a USDT-denominated operation arrives
 *   (mintv2 ecash receives emit those, e.g. incoming chat ecash payments)
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
                // `pending` = detected on-chain but not credited yet, so the
                // balance hasn't changed (and the event repeats every poll)
                if (event.state.type === 'pending') return
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
        const unsubscribeTransactions = fedimint.addListener(
            'transaction',
            event => {
                if (event.federationId !== federationId) return
                if (event.transaction.unit !== 'usdt') return
                log.info('USDT transaction event', event.transaction.kind)
                refreshBalance()
            },
        )

        return () => {
            unsubscribeDeposits()
            unsubscribeWithdrawals()
            unsubscribeTransactions()
            clearInterval(usdtBalanceMonitor)
        }
    }, [dispatch, fedimint, federationId, isUsdtSupported])
}
