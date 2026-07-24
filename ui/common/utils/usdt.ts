/**
 * Utilities for working with USDT amounts.
 *
 * USDT amounts are represented in "micros" (10^-6 USDT), so
 * 1 USDT = 1_000_000 micros.
 */

export const USDT_MICROS_PER_USDT = 1_000_000

/** Maximum number of decimal places a USDT amount can have */
export const USDT_DECIMALS = 6

/**
 * Formats an amount of USDT micros for display, e.g. `1500000` -> "1.50 USDT".
 *
 * Always shows at least 2 decimal places, extending up to 6 decimal places
 * when needed to preserve full precision.
 */
export function formatUsdtMicros(
    micros: number,
    { symbol = true }: { symbol?: boolean } = {},
): string {
    const sign = micros < 0 ? '-' : ''
    const abs = Math.abs(Math.round(micros))
    const whole = Math.floor(abs / USDT_MICROS_PER_USDT)
    const fraction = abs % USDT_MICROS_PER_USDT

    // Group the whole part with commas, e.g. 1234567 -> "1,234,567"
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

    // Keep the first 2 decimal places always, and any further non-zero
    // precision beyond that (up to 6 decimal places total)
    const fractionStr = fraction.toString().padStart(USDT_DECIMALS, '0')
    const decimals =
        fractionStr.slice(0, 2) + fractionStr.slice(2).replace(/0+$/, '')

    return `${sign}${wholeStr}.${decimals}${symbol ? ' USDT' : ''}`
}

/**
 * Parses user input of a decimal USDT amount into micros.
 *
 * Returns `null` if the input is not a valid USDT amount (empty, malformed,
 * more than 6 decimal places, or too large to represent safely).
 */
export function parseUsdtInput(input: string): number | null {
    let trimmed = input.trim()
    // Accept a comma as the decimal separator if no dot is present
    // (some numeric keyboards produce commas in certain locales)
    if (trimmed.includes(',') && !trimmed.includes('.')) {
        if (trimmed.indexOf(',') !== trimmed.lastIndexOf(',')) return null
        trimmed = trimmed.replace(',', '.')
    }

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
            const parsed = parseUsdtInput(decodeURIComponent(value))
            if (parsed !== null && parsed > 0) amountMicros = parsed
            break
        }
    }

    return { address: candidate, amountMicros }
}
