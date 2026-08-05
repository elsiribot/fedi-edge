import type { RpcUsdtWithdrawalStatus } from '../../../types/bindings'
import amountUtils from '../../../utils/AmountUtils'
import {
    formatUsdtMicros,
    isTronAddress,
    isValidEvmAddress,
    microsToDecimalString,
    parseUsdtInput,
    parseUsdtRecipientInput,
    selectUsdtTxidsToFetch,
    USDT_MICROS_PER_USDT,
} from '../../../utils/usdt'

describe('usdt utils', () => {
    describe('formatUsdtMicros', () => {
        it('formats whole amounts with 2 decimal places', () => {
            expect(formatUsdtMicros(0)).toBe('0.00 USDT')
            expect(formatUsdtMicros(USDT_MICROS_PER_USDT)).toBe('1.00 USDT')
            expect(formatUsdtMicros(25_000_000)).toBe('25.00 USDT')
        })

        it('formats fractional amounts with at least 2 decimal places', () => {
            expect(formatUsdtMicros(1_500_000)).toBe('1.50 USDT')
            expect(formatUsdtMicros(1_230_000)).toBe('1.23 USDT')
            expect(formatUsdtMicros(100_000)).toBe('0.10 USDT')
        })

        it('truncates (rounds down) beyond 2 decimal places by default', () => {
            // 2.000384 USDT -> "2.00 USDT", never overstating the amount
            expect(formatUsdtMicros(2_000_384)).toBe('2.00 USDT')
            expect(formatUsdtMicros(1_234_567)).toBe('1.23 USDT')
            expect(formatUsdtMicros(1_234_500)).toBe('1.23 USDT')
        })

        it('renders a non-zero amount that truncates to 0.00 as "<0.01" (dust guard)', () => {
            expect(formatUsdtMicros(1)).toBe('<0.01 USDT')
            expect(formatUsdtMicros(9_999)).toBe('<0.01 USDT')
        })

        it('renders an exact zero amount as "0.00", with no dust prefix', () => {
            expect(formatUsdtMicros(0)).toBe('0.00 USDT')
        })

        it('rounds up when opts.rounding is "up" (for fee/cost displays)', () => {
            // 0.047497 USDT fee -> "0.05 USDT", never understating a cost
            expect(formatUsdtMicros(47_497, { rounding: 'up' })).toBe(
                '0.05 USDT',
            )
            // already exact at 2dp - rounding up doesn't change it
            expect(formatUsdtMicros(1_230_000, { rounding: 'up' })).toBe(
                '1.23 USDT',
            )
            // zero stays zero even when rounding up
            expect(formatUsdtMicros(0, { rounding: 'up' })).toBe('0.00 USDT')
        })

        it('groups large whole amounts with commas', () => {
            expect(formatUsdtMicros(1_234_567_000_000)).toBe(
                '1,234,567.00 USDT',
            )
        })

        it('formats negative amounts', () => {
            expect(formatUsdtMicros(-1_500_000)).toBe('-1.50 USDT')
        })

        it('omits the symbol when requested', () => {
            expect(formatUsdtMicros(1_500_000, { symbol: false })).toBe('1.50')
        })

        it('formats using locale-specific grouping/decimal separators', () => {
            expect(formatUsdtMicros(1_234_560_000, { locale: 'de-DE' })).toBe(
                '1.234,56 USDT',
            )
            expect(formatUsdtMicros(1_234_560_000, { locale: 'en-US' })).toBe(
                '1,234.56 USDT',
            )
        })
    })

    describe('microsToDecimalString', () => {
        it('formats as a plain, non-localized decimal string', () => {
            expect(microsToDecimalString(0)).toBe('0.00')
            expect(microsToDecimalString(1_500_000)).toBe('1.50')
            expect(microsToDecimalString(1_234_567)).toBe('1.234567')
            expect(microsToDecimalString(1_234_567_000_000)).toBe('1234567.00')
            expect(microsToDecimalString(-1_500_000)).toBe('-1.50')
        })
    })

    describe('parseUsdtInput', () => {
        it('parses whole amounts', () => {
            expect(parseUsdtInput('1')).toBe(1_000_000)
            expect(parseUsdtInput('25')).toBe(25_000_000)
            expect(parseUsdtInput('0')).toBe(0)
        })

        it('parses decimal amounts', () => {
            expect(parseUsdtInput('1.5')).toBe(1_500_000)
            expect(parseUsdtInput('0.000001')).toBe(1)
            expect(parseUsdtInput('.5')).toBe(500_000)
            expect(parseUsdtInput('1.234567')).toBe(1_234_567)
        })

        it('accepts a comma as the decimal separator', () => {
            expect(parseUsdtInput('1,5')).toBe(1_500_000)
        })

        it('rejects invalid input', () => {
            expect(parseUsdtInput('')).toBeNull()
            expect(parseUsdtInput('.')).toBeNull()
            expect(parseUsdtInput('abc')).toBeNull()
            expect(parseUsdtInput('1.2.3')).toBeNull()
            expect(parseUsdtInput('-1')).toBeNull()
            expect(parseUsdtInput('1.2345678')).toBeNull()
            expect(parseUsdtInput('1,000.5')).toBeNull()
        })
    })

    describe('parseUsdtInput with opts.maxDecimals (UI entry cap)', () => {
        it('accepts up to maxDecimals decimal places', () => {
            expect(parseUsdtInput('1.23', { maxDecimals: 2 })).toBe(1_230_000)
            expect(parseUsdtInput('1', { maxDecimals: 2 })).toBe(1_000_000)
        })

        it('rejects more than maxDecimals decimal places', () => {
            expect(parseUsdtInput('1.234', { maxDecimals: 2 })).toBeNull()
        })

        it('still accepts up to 6 decimals when maxDecimals is omitted (machine default)', () => {
            expect(parseUsdtInput('1.234567')).toBe(1_234_567)
        })
    })

    describe('parseUsdtInput with a locale decimal separator', () => {
        it('treats the other separator as a grouping separator', () => {
            expect(parseUsdtInput('1,000', { decimalSeparator: '.' })).toBe(
                1_000_000_000,
            ) // 1000 USDT in micros
            expect(parseUsdtInput('1,5', { decimalSeparator: ',' })).toBe(
                1_500_000,
            )
        })

        it('tolerates a trailing decimal separator', () => {
            expect(parseUsdtInput('1.', { decimalSeparator: '.' })).toBe(
                1_000_000,
            )
        })

        it('rejects ambiguous forms', () => {
            // comma isn't valid grouping (not a group of 3) and isn't the
            // decimal separator either
            expect(parseUsdtInput('1,5', { decimalSeparator: '.' })).toBeNull()
            expect(
                parseUsdtInput('1.5.5', { decimalSeparator: '.' }),
            ).toBeNull()
        })

        it('accepts an explicit groupingSeparator that overrides the legacy guess', () => {
            // de-CH groups with U+2019 (right single quotation mark) and
            // decimals with '.' - the legacy guess (',') would never match
            // this, so it must come from the explicit option
            expect(
                parseUsdtInput('1\u2019234.56', {
                    decimalSeparator: '.',
                    groupingSeparator: '\u2019',
                }),
            ).toBe(1_234_560_000)
        })

        it('recognizes space- and apostrophe-like grouping separators even when not passed explicitly', () => {
            // fr-FR's narrow no-break space (U+202F)
            expect(
                parseUsdtInput('1\u202F234,56', { decimalSeparator: ',' }),
            ).toBe(1_234_560_000)
            // a plain space (U+0020) typed in place of the narrow no-break space
            expect(
                parseUsdtInput('1\u0020234,56', { decimalSeparator: ',' }),
            ).toBe(1_234_560_000)
            // a no-break space (U+00A0)
            expect(
                parseUsdtInput('1\u00A0234,56', { decimalSeparator: ',' }),
            ).toBe(1_234_560_000)
            // de-CH's apostrophe (either code point), decimal separator '.'
            expect(
                parseUsdtInput('1\u0027234.56', { decimalSeparator: '.' }),
            ).toBe(1_234_560_000)
            expect(
                parseUsdtInput('1\u2019234.56', { decimalSeparator: '.' }),
            ).toBe(1_234_560_000)
        })

        it('still rejects malformed groupings with the new candidates', () => {
            // second group is only 2 digits, not a well-formed group of 3
            expect(
                parseUsdtInput('1\u002023,56', { decimalSeparator: ',' }),
            ).toBeNull()
            expect(
                parseUsdtInput('1\u002723,56', { decimalSeparator: '.' }),
            ).toBeNull()
        })

        it.each(['en-US', 'de-DE', 'fr-FR', 'de-CH'])(
            'round-trips formatUsdtMicros through parseUsdtInput for %s',
            locale => {
                const decimalSeparator = amountUtils.getDecimalSeparator({
                    locale,
                })
                const groupingSeparator = amountUtils.getThousandsSeparator({
                    locale,
                })
                const formatted = formatUsdtMicros(1_234_560_000, {
                    locale,
                    symbol: false,
                })
                expect(
                    parseUsdtInput(formatted, {
                        decimalSeparator,
                        groupingSeparator,
                    }),
                ).toBe(1_234_560_000)
            },
        )
    })

    describe('isValidEvmAddress', () => {
        it('accepts valid 0x addresses', () => {
            expect(
                isValidEvmAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
            ).toBe(true)
        })

        it('rejects invalid addresses', () => {
            expect(isValidEvmAddress('')).toBe(false)
            expect(isValidEvmAddress('0x1234')).toBe(false)
            expect(
                isValidEvmAddress('dAC17F958D2ee523a2206206994597C13D831ec7'),
            ).toBe(false)
            expect(
                isValidEvmAddress('0xZZC17F958D2ee523a2206206994597C13D831ec7'),
            ).toBe(false)
        })
    })

    describe('isTronAddress', () => {
        it('accepts base58 T-prefixed 34-char addresses', () => {
            expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(
                true,
            )
            expect(isTronAddress('  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t ')).toBe(
                true,
            )
        })

        it('rejects non-Tron inputs', () => {
            expect(isTronAddress('')).toBe(false)
            // EVM address
            expect(
                isTronAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
            ).toBe(false)
            // wrong length
            expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6')).toBe(
                false,
            )
            expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tt')).toBe(
                false,
            )
            // non-base58 characters (0, O, I, l)
            expect(isTronAddress('T0OIlHqjeKQxGTCi8q8ZY4pL8otSzgjLj6')).toBe(
                false,
            )
            // T-prefixed English word paste must not trigger the Tron copy
            expect(isTronAddress('Transactions')).toBe(false)
        })
    })

    describe('parseUsdtRecipientInput', () => {
        const address = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

        it('accepts raw 0x addresses', () => {
            expect(parseUsdtRecipientInput(address)).toEqual({ address })
            expect(parseUsdtRecipientInput(`  ${address}  `)).toEqual({
                address,
            })
        })

        it('accepts ethereum: URIs', () => {
            expect(parseUsdtRecipientInput(`ethereum:${address}`)).toEqual({
                address,
            })
            expect(parseUsdtRecipientInput(`ETHEREUM:${address}`)).toEqual({
                address,
            })
        })

        it('strips chain ids and query params, ignoring EIP-681 amounts', () => {
            expect(parseUsdtRecipientInput(`ethereum:${address}@1`)).toEqual({
                address,
            })
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?value=1000000`),
            ).toEqual({ address })
            expect(
                parseUsdtRecipientInput(
                    `ethereum:${address}@1/transfer?uint256=1000000`,
                ),
            ).toEqual({ address })
        })

        it('extracts the amount param as decimal USDT', () => {
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=1.5`),
            ).toEqual({ address, amountMicros: 1_500_000 })
            expect(
                parseUsdtRecipientInput(`ethereum:${address}@1?amount=25`),
            ).toEqual({ address, amountMicros: 25_000_000 })
            expect(
                parseUsdtRecipientInput(
                    `ethereum:${address}?foo=bar&amount=0.000001`,
                ),
            ).toEqual({ address, amountMicros: 1 })
        })

        it('ignores invalid or non-positive amount params', () => {
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=abc`),
            ).toEqual({ address })
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=0`),
            ).toEqual({ address })
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=`),
            ).toEqual({ address })
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=1.2345678`),
            ).toEqual({ address })
        })

        it('rejects invalid input', () => {
            expect(parseUsdtRecipientInput('')).toBeNull()
            expect(parseUsdtRecipientInput('0x1234')).toBeNull()
            expect(parseUsdtRecipientInput('ethereum:0x1234')).toBeNull()
            expect(parseUsdtRecipientInput('bitcoin:bc1qxyz')).toBeNull()
            expect(
                parseUsdtRecipientInput('ethereum:0x1234?amount=1.5'),
            ).toBeNull()
        })

        it('returns null on a malformed amount percent-encoding instead of throwing', () => {
            // `%` is invalid percent-encoding — `decodeURIComponent` throws.
            // The whole URI is malformed, so reject it rather than crash.
            expect(() =>
                parseUsdtRecipientInput(`ethereum:${address}?amount=%`),
            ).not.toThrow()
            expect(
                parseUsdtRecipientInput(`ethereum:${address}?amount=%`),
            ).toBeNull()
        })
    })

    describe('selectUsdtTxidsToFetch', () => {
        const queued: RpcUsdtWithdrawalStatus = { type: 'queued' }
        const confirmed: RpcUsdtWithdrawalStatus = {
            type: 'confirmed',
            block: 1,
        }
        const failed: RpcUsdtWithdrawalStatus = { type: 'failed', reason: 'x' }

        it('selects txids never fetched before', () => {
            expect(selectUsdtTxidsToFetch(['a', 'b'], {}, new Set())).toEqual([
                'a',
                'b',
            ])
        })

        it('skips null txids (non-withdrawal transactions)', () => {
            expect(
                selectUsdtTxidsToFetch([null, 'a', null], {}, new Set()),
            ).toEqual(['a'])
        })

        it('skips already-fetched txids whose status is still unknown', () => {
            // Already attempted this session but no status came back yet -
            // don't hammer the RPC again until a refresh clears the cache.
            expect(selectUsdtTxidsToFetch(['a'], {}, new Set(['a']))).toEqual(
                [],
            )
        })

        it('re-selects an already-fetched txid once removed from the cache (pull-to-refresh) if still pending', () => {
            expect(
                selectUsdtTxidsToFetch(['a'], { a: queued }, new Set()),
            ).toEqual(['a'])
        })

        it('never re-selects a txid whose last known status is terminal, even once removed from the cache', () => {
            expect(
                selectUsdtTxidsToFetch(
                    ['a', 'b'],
                    { a: confirmed, b: failed },
                    new Set(),
                ),
            ).toEqual([])
        })

        it('mixes terminal and pending rows correctly', () => {
            expect(
                selectUsdtTxidsToFetch(
                    ['pending', 'done', 'new'],
                    { pending: queued, done: confirmed },
                    new Set(),
                ),
            ).toEqual(['pending', 'new'])
        })
    })
})
