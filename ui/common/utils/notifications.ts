/**
 * Utilities for formatting locally-generated notifications (background
 * payment-received push notifications, USDT deposit-claimed
 * notifications, etc) that fire from outside a React tree.
 */

import { RpcEcashUnit } from '../types/bindings'
import { MSats } from '../types/units'
import amountUtils from './AmountUtils'
import { formatUsdtMicros } from './usdt'

/**
 * Formats a transaction's amount + unit label for a locally-generated
 * notification body, e.g. `{ amount: 5_000_000, unit: 'usdt' }` ->
 * "5.00 USDT", or `{ amount: 5_000_000, unit: 'bitcoin' }` (5,000,000
 * msats) -> "5,000 SATS".
 *
 * Notification dispatch happens outside of React (no `useTranslation`
 * context, and no access to the user's chosen currency locale from
 * redux), so - mirroring the locale-less convention already documented
 * on the redux/utils call sites from e16c2721 (e.g. `redux/matrix.ts`'s
 * `formatUsdtMicros(amount)` calls, which format with the platform
 * default locale rather than the user's configured display-currency
 * locale) - this always formats with the default locale.
 *
 * The "SATS"/"USDT" unit labels themselves are intentionally hardcoded
 * rather than run through i18n: they read as currency codes rather than
 * translatable natural-language words, matching `formatUsdtMicros`'s own
 * hardcoded " USDT" suffix. This keeps the formatter pure (no `t()`
 * dependency) so it can be unit tested and reused outside any React tree.
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
}): string | undefined {
    switch (tx.unit) {
        case 'usdt':
            return formatUsdtMicros(tx.amount)
        case 'bitcoin':
            return `${amountUtils.formatNumber(amountUtils.msatToSat(tx.amount as MSats))} SATS`
        case 'other':
            return undefined
    }
}
