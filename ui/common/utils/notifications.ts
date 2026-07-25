/**
 * Utilities for formatting locally-generated notifications (background
 * payment-received push notifications, USDT deposit-claimed
 * notifications, etc) that fire from outside a React tree.
 */

import { RpcEcashUnit } from '../types/bindings'
import { MSats } from '../types/units'
import amountUtils from './AmountUtils'
import { formatUsdtMicros } from './usdt'

/** Discriminates the two denominations a locally-generated payment
 * notification can be formatted for; see `formatNotificationAmount`. */
export type NotificationAmountUnit = 'sats' | 'usdt'

/**
 * Formats just the numeric portion of a transaction's amount for a
 * locally-generated notification body, along with which unit it's
 * denominated in, e.g. `{ amount: 5_000_000, unit: 'usdt' }` ->
 * `{ formattedNumber: '5.00', unit: 'usdt' }`, or
 * `{ amount: 5_000_000, unit: 'bitcoin' }` (5,000,000 msats) ->
 * `{ formattedNumber: '5,000', unit: 'sats' }`.
 *
 * Notification dispatch happens outside of React (no `useTranslation`
 * context, and no access to the user's chosen currency locale from
 * redux), so - mirroring the locale-less convention already documented
 * on the redux/utils call sites from e16c2721 (e.g. `redux/matrix.ts`'s
 * `formatUsdtMicros(amount)` calls, which format with the platform
 * default locale rather than the user's configured display-currency
 * locale) - this always formats with the default locale.
 *
 * This deliberately returns only the formatted number, not a full
 * "N SATS"/"N USDT" string: the "sats" unit label is a translatable
 * natural-language word (`t('words.sats')`, e.g. Ukrainian "сатоші"),
 * so baking a hardcoded English label in here would silently break
 * localization. Composing the final label string is left to the caller,
 * which has access to `t`; this keeps the formatter itself pure (no
 * `t()` dependency) so it stays unit testable and reusable outside any
 * React tree. "USDT" is left as a caller-side literal too (rather than
 * translated), since it reads as a currency code with zero per-locale
 * variation, matching `formatUsdtMicros`'s own hardcoded " USDT" suffix.
 *
 * `unit: 'other'` means the amount's denomination is unknown/unstamped
 * (see `RpcEcashUnit`'s doc comment) - there is no safe way to guess
 * whether it should be read as sats or USDT, so this returns `undefined`
 * and callers should skip the notification entirely rather than risk
 * showing a wildly-wrong magnitude.
 */
export function formatNotificationAmount(tx: {
    amount: number
    unit: RpcEcashUnit
}): { formattedNumber: string; unit: NotificationAmountUnit } | undefined {
    switch (tx.unit) {
        case 'usdt':
            return {
                formattedNumber: formatUsdtMicros(tx.amount, {
                    symbol: false,
                }),
                unit: 'usdt',
            }
        case 'bitcoin':
            return {
                formattedNumber: amountUtils.formatNumber(
                    amountUtils.msatToSat(tx.amount as MSats),
                ),
                unit: 'sats',
            }
        case 'other':
            return undefined
    }
}
