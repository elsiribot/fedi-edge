import { act } from '@testing-library/react'

import { setupStore } from '../../../redux'
import { renderHookWithState } from '../../utils/render'
import { useFormatUsdtMicros, useUsdtAmountInput } from '../../../hooks/usdt'

describe('common/hooks/usdt', () => {
    let store: ReturnType<typeof setupStore>

    beforeEach(() => {
        store = setupStore()
    })

    describe('useUsdtAmountInput', () => {
        it('caps typed entry at 2 decimal places (entry precision policy)', () => {
            const { result } = renderHookWithState(
                () => useUsdtAmountInput(),
                store,
            )

            act(() => {
                result.current.setAmountInput('1.23')
            })
            expect(result.current.amountMicros).toBe(1_230_000)

            act(() => {
                result.current.setAmountInput('1.234')
            })
            // a 3rd decimal digit is rejected at the parse level - not
            // silently truncated - so the field shows an invalid amount
            expect(result.current.amountMicros).toBeNull()
        })

        it('truncates a sub-cent-precision prefill to cents, both for initialMicros and setAmountFromMicros', () => {
            // 1.234567 USDT scanned from an external wallet - the
            // prefilled input must truncate to cents (never send more
            // than was scanned), even though full precision is preserved
            // in the machine-format URI parse itself
            const { result: initial } = renderHookWithState(
                () => useUsdtAmountInput({ initialMicros: 1_234_567 }),
                store,
            )
            expect(initial.current.amountMicros).toBe(1_230_000)

            const { result } = renderHookWithState(
                () => useUsdtAmountInput(),
                store,
            )
            act(() => {
                result.current.setAmountFromMicros(1_234_567)
            })
            expect(result.current.amountMicros).toBe(1_230_000)
        })

        it('clears the field when setAmountFromMicros is passed a falsy value', () => {
            const { result } = renderHookWithState(
                () => useUsdtAmountInput({ initialMicros: 1_500_000 }),
                store,
            )
            act(() => {
                result.current.setAmountFromMicros(null)
            })
            expect(result.current.amountInput).toBe('')
        })
    })

    describe('useFormatUsdtMicros', () => {
        it('threads opts.rounding through to formatUsdtMicros (fee displays round up)', () => {
            const { result } = renderHookWithState(
                () => useFormatUsdtMicros(),
                store,
            )

            expect(result.current(47_497, { rounding: 'up' })).toBe(
                '0.05 USDT',
            )
            expect(result.current(2_000_384)).toBe('2.00 USDT')
        })
    })
})
