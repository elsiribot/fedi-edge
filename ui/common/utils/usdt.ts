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
