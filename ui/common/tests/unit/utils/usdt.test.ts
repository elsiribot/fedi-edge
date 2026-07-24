import {
    formatUsdtMicros,
    isValidEvmAddress,
    parseUsdtInput,
    parseUsdtRecipientInput,
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

        it('keeps full 6-decimal precision when needed', () => {
            expect(formatUsdtMicros(1)).toBe('0.000001 USDT')
            expect(formatUsdtMicros(1_234_567)).toBe('1.234567 USDT')
            expect(formatUsdtMicros(1_234_500)).toBe('1.2345 USDT')
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
    })
})
