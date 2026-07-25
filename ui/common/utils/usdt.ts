/**
 * Utilities for working with USDT amounts.
 *
 * USDT amounts are represented in "micros" (10^-6 USDT), so
 * 1 USDT = 1_000_000 micros.
 */
import type { RpcUsdtWithdrawalStatus } from '../types/bindings'
import amountUtils from './AmountUtils'

export const USDT_MICROS_PER_USDT = 1_000_000

/** Maximum number of decimal places a USDT amount can have */
export const USDT_DECIMALS = 6

/** Escapes a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Space-like characters various locales/platforms use as a grouping
 * separator, e.g. `Intl.NumberFormat('fr-FR').format(...)` groups with
 * U+202F (narrow no-break space), but a plain space or U+00A0 (no-break
 * space) are common substitutes a user might type/paste. Treated as
 * interchangeable grouping separators regardless of `opts.groupingSeparator`.
 */
const GROUPING_SPACE_CHARS = ['\u0020', '\u00A0', '\u202F']

/**
 * Apostrophe-like characters used as a grouping separator by some locales
 * (e.g. de-CH), which - depending on the JS engine's ICU data - may render
 * as either the ASCII apostrophe (U+0027) or the Unicode right single
 * quotation mark (U+2019).
 */
const GROUPING_APOSTROPHE_CHARS = ['\u0027', '\u2019']

/**
 * Splits an amount of USDT micros into its sign, whole-USDT part, and a
 * decimal-digit string (2..6 digits, trailing zeros beyond the 2nd place
 * stripped) - using integer division/modulo throughout. This is the
 * shared basis for both `formatUsdtMicros` and `microsToDecimalString` so
 * neither ever routes the amount through `micros / 1_000_000` as a
 * floating point number, which could lose precision for large amounts.
 */
function splitUsdtMicros(micros: number): {
    sign: string
    whole: number
    decimals: string
} {
    const sign = micros < 0 ? '-' : ''
    const abs = Math.abs(Math.round(micros))
    const whole = Math.floor(abs / USDT_MICROS_PER_USDT)
    const fraction = abs % USDT_MICROS_PER_USDT

    // Keep the first 2 decimal places always, and any further non-zero
    // precision beyond that (up to 6 decimal places total)
    const fractionStr = fraction.toString().padStart(USDT_DECIMALS, '0')
    const decimals =
        fractionStr.slice(0, 2) + fractionStr.slice(2).replace(/0+$/, '')

    return { sign, whole, decimals }
}

/**
 * Formats an amount of USDT micros for on-screen display, e.g.
 * `1500000` -> "1.50 USDT", using the grouping and decimal separators of
 * `opts.locale` (default: the platform's default locale, same as
 * `AmountUtils`'s other `locale`-less calls) via `Intl.NumberFormat` -
 * exactly like `AmountUtils.toLocaleString`/`getDecimalSeparator` do.
 *
 * Always shows at least 2 decimal places, extending up to 6 decimal places
 * when needed to preserve full precision.
 *
 * This is a *display* helper - the string it returns is locale-formatted
 * and must never be embedded in a URI or other machine-readable value.
 * Use `microsToDecimalString` for that.
 */
export function formatUsdtMicros(
    micros: number,
    { symbol = true, locale }: { symbol?: boolean; locale?: string } = {},
): string {
    const { sign, whole, decimals } = splitUsdtMicros(micros)

    // Group the whole part per the locale's convention, e.g. 1234567 ->
    // "1,234,567" (en-US) or "1.234.567" (de-DE)
    const wholeStr = new Intl.NumberFormat(locale).format(whole)
    const decimalSeparator = amountUtils.getDecimalSeparator({ locale })

    return `${sign}${wholeStr}${decimalSeparator}${decimals}${symbol ? ' USDT' : ''}`
}

/**
 * Converts USDT micros to a plain, non-localized decimal string, e.g.
 * `1500000` -> "1.50" (always a literal `.` decimal separator, no
 * grouping, no currency symbol/suffix).
 *
 * This is the *machine* format - use it anywhere the value needs to be
 * consumed by code rather than read by a human, e.g. `ethereum:...?amount=`
 * request URIs, or to prefill an amount-input field's raw text (which
 * itself uses the locale separator once entered, but is seeded here in
 * machine form and normalized by the input). Never use this for
 * user-facing display; use `formatUsdtMicros` for that.
 */
export function microsToDecimalString(micros: number): string {
    const { sign, whole, decimals } = splitUsdtMicros(micros)
    return `${sign}${whole}.${decimals}`
}

/**
 * Parses user input of a decimal USDT amount into micros.
 *
 * `opts.decimalSeparator` identifies the locale's decimal separator (e.g.
 * `.` for en-US, `,` for de-DE). When present, grouping separators are
 * recognized and stripped so the function can re-parse its own
 * `formatUsdtMicros({ locale })` output, in this priority order:
 *   1. `opts.groupingSeparator`, if passed (the caller's locale grouping
 *      separator, e.g. via `amountUtils.getThousandsSeparator({ locale })`).
 *   2. The legacy `,`/`.` counterpart of `decimalSeparator` (kept for
 *      back-compat with callers that only pass `decimalSeparator`).
 *   3. Space-like characters (U+0020, U+00A0, U+202F) and apostrophe-like
 *      characters (U+0027, U+2019) - recognized unconditionally, since
 *      these are the grouping characters `Intl.NumberFormat` actually
 *      produces for space/apostrophe-grouping locales (e.g. fr-FR's
 *      U+202F, de-CH's U+2019/U+0027 depending on the JS engine's ICU
 *      data) and a caller may reasonably type a plain space/apostrophe
 *      substitute for either.
 * Each candidate is only stripped when it forms well-formed digit groups of
 * 3 (e.g. `"1,000"` with `decimalSeparator: '.'` parses as 1000 USDT;
 * `"1,5"` with `decimalSeparator: ','` parses as 1.5 USDT) - anything else
 * is ambiguous and rejected (`null`) rather than guessed at. A trailing
 * decimal separator is tolerated, e.g. `"5."` parses as 5 USDT - useful for
 * validating amounts while they're still being typed.
 *
 * When `opts.decimalSeparator` is omitted, only `.` is treated as a
 * decimal separator, except a lone `,` is still accepted as one when no
 * `.` is present (legacy behavior - some numeric keypads emit commas for
 * decimals regardless of locale). No grouping separators are recognized
 * in this mode, and `opts.groupingSeparator` is ignored.
 *
 * Returns `null` if the input is not a valid USDT amount (empty,
 * malformed, ambiguous, more than 6 decimal places, or too large to
 * represent safely).
 */
export function parseUsdtInput(
    input: string,
    opts: { decimalSeparator?: string; groupingSeparator?: string } = {},
): number | null {
    // Strip surrounding whitespace and a trailing currency symbol/suffix
    let trimmed = input
        .trim()
        .replace(/\s*USDT\s*$/i, '')
        .trim()
    if (trimmed === '') return null

    if (opts.decimalSeparator) {
        const decimalSeparator = opts.decimalSeparator

        // Candidate grouping separators to try, in priority order (see
        // docstring), deduped while preserving that order.
        const candidateList = [
            opts.groupingSeparator,
            decimalSeparator === ',' ? '.' : ',',
            ...GROUPING_SPACE_CHARS,
            ...GROUPING_APOSTROPHE_CHARS,
        ].filter(
            (c, i, arr): c is string =>
                !!c && c !== decimalSeparator && arr.indexOf(c) === i,
        )

        // Strip grouping separators, but only when they form well-formed
        // groups of 3 digits (e.g. "1,000,000") - otherwise the input is
        // ambiguous and rejected rather than guessed at.
        for (const groupingSeparator of candidateList) {
            if (!trimmed.includes(groupingSeparator)) continue
            const groupingPattern = new RegExp(
                `^\\d{1,3}(${escapeRegExp(groupingSeparator)}\\d{3})+(${escapeRegExp(decimalSeparator)}\\d+)?$`,
            )
            if (!groupingPattern.test(trimmed)) return null
            trimmed = trimmed.split(groupingSeparator).join('')
            break
        }

        // Normalize the locale decimal separator to '.'
        if (decimalSeparator !== '.') {
            if (
                trimmed.indexOf(decimalSeparator) !==
                trimmed.lastIndexOf(decimalSeparator)
            )
                return null
            trimmed = trimmed.replace(decimalSeparator, '.')
        }
    } else if (trimmed.includes(',') && !trimmed.includes('.')) {
        // Legacy default: accept a lone comma as the decimal separator
        // when no dot is present
        if (trimmed.indexOf(',') !== trimmed.lastIndexOf(',')) return null
        trimmed = trimmed.replace(',', '.')
    }

    // Tolerate (and drop) a trailing decimal separator, e.g. "5." -> "5"
    trimmed = trimmed.replace(/\.$/, '')

    const match = trimmed.match(/^(\d+)?(?:\.(\d{1,6}))?$/)
    if (!match || (!match[1] && !match[2])) return null

    const whole = parseInt(match[1] || '0', 10)
    const fraction = parseInt(
        (match[2] || '').padEnd(USDT_DECIMALS, '0') || '0',
        10,
    )
    const micros = whole * USDT_MICROS_PER_USDT + fraction

    if (!Number.isSafeInteger(micros)) return null

    return micros
}

/**
 * Validates an EVM (0x...) address as a USDT recipient / deposit address.
 */
export function isValidEvmAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address)
}

export type ParsedUsdtRecipient = {
    /** Bare `0x…` recipient address */
    address: string
    /** Requested amount in micros, from an `?amount=` (decimal USDT) param */
    amountMicros?: number
}

/**
 * Parses scanned/pasted input into a USDT recipient (EVM) address.
 *
 * Accepts:
 * - Raw `0x…` (40 hex chars) addresses
 * - `ethereum:0x…` URIs, with an optional `@chainId` suffix, EIP-681
 *   function name (e.g. `/transfer`) and/or `?param=…` query string.
 *
 * A Fedi-convention `?amount=<decimal USDT>` query param is extracted so
 * a Fedi-to-Fedi scan can prefill the send amount. EIP-681 amount params
 * (`value` / `uint256`) are deliberately ignored — they are ambiguous
 * for token transfers.
 *
 * Returns the bare `0x…` address (plus the requested amount, if any),
 * or `null` if the input does not contain a valid EVM address.
 */
export function parseUsdtRecipientInput(
    input: string,
): ParsedUsdtRecipient | null {
    let candidate = input.trim()
    let query: string | undefined

    const uriMatch = candidate.match(/^ethereum:(.+)$/i)
    if (uriMatch) {
        // Split off query params, then strip the EIP-681 function name
        // and chain id from the target address
        const [target, ...queryParts] = uriMatch[1].split('?')
        query = queryParts.join('?')
        candidate = target.split('/')[0].split('@')[0]
    }

    if (!isValidEvmAddress(candidate)) return null

    let amountMicros: number | undefined
    if (query) {
        for (const param of query.split('&')) {
            const [key, value = ''] = param.split('=')
            if (key.toLowerCase() !== 'amount') continue
            let decoded: string
            try {
                decoded = decodeURIComponent(value)
            } catch {
                // Malformed percent-encoding (e.g. a lone `%`) — the URI
                // itself is invalid, so reject the whole input rather than
                // throw or silently drop just the amount.
                return null
            }
            // Machine format only - URIs never carry locale-formatted amounts
            const parsed = parseUsdtInput(decoded)
            if (parsed !== null && parsed > 0) amountMicros = parsed
            break
        }
    }

    return { address: candidate, amountMicros }
}

/** Withdrawal status types that will never change again. */
function isTerminalUsdtWithdrawalStatus(
    status: RpcUsdtWithdrawalStatus | undefined,
): boolean {
    return status?.type === 'confirmed' || status?.type === 'failed'
}

/**
 * Selects which USDT withdrawal txids should have their status (re)fetched
 * for a transaction-history screen's per-row badge.
 *
 * A txid is selected when it hasn't been fetched yet (absent from
 * `alreadyFetchedTxids`), or its last known status in `statusByTxid` is
 * still non-terminal (`unknown`/`queued`/`signing`/`submitted`, or no
 * status at all). Once a withdrawal reaches a terminal status
 * (`confirmed`/`failed`) it's never re-fetched again, even if the caller
 * clears `alreadyFetchedTxids` (e.g. on pull-to-refresh) - so a manual
 * refresh re-polls stuck-pending withdrawals without re-checking
 * withdrawals that have already settled.
 *
 * `txids` may contain `null` (e.g. non-withdrawal transactions, or
 * withdrawals whose txid hasn't been assigned yet) - these are skipped.
 */
export function selectUsdtTxidsToFetch(
    txids: ReadonlyArray<string | null>,
    statusByTxid: Readonly<Record<string, RpcUsdtWithdrawalStatus>>,
    alreadyFetchedTxids: ReadonlySet<string>,
): string[] {
    const result: string[] = []
    for (const txid of txids) {
        if (!txid) continue
        if (alreadyFetchedTxids.has(txid)) continue
        if (isTerminalUsdtWithdrawalStatus(statusByTxid[txid])) continue
        result.push(txid)
    }
    return result
}
