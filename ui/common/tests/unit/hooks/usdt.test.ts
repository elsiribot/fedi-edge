import { act, waitFor } from '@testing-library/react'

import { setFederations, setupStore } from '../../../redux'
import { Federation } from '../../../types'
import { mockFederation1 } from '../../mock-data/federation'
import { createMockFedimintBridge } from '../../utils/fedimint'
import { renderHookWithState } from '../../utils/render'
import {
    useFormatUsdtMicros,
    useMonitorUsdtAccount,
    useUsdtAmountInput,
} from '../../../hooks/usdt'

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

    describe('useMonitorUsdtAccount', () => {
        const usdtFederation = {
            ...mockFederation1,
            clientConfig: {
                global: {},
                modules: {
                    usdt: { kind: 'usdt' },
                },
            },
        } satisfies Federation

        const renderMonitor = () => {
            const fedimint = createMockFedimintBridge({
                usdtBalance: 5_000_000,
            })
            store.dispatch(setFederations([usdtFederation]))
            renderHookWithState(
                () => useMonitorUsdtAccount(usdtFederation.id),
                store,
                fedimint,
            )
            const getListener = (event: string) =>
                (fedimint.addListener as jest.Mock).mock.calls.find(
                    ([e]) => e === event,
                )?.[1]
            return { fedimint, getListener }
        }

        it('refreshes the balance on mount and on USDT-unit transaction events', async () => {
            const { fedimint, getListener } = renderMonitor()

            await waitFor(() =>
                expect(fedimint.usdtBalance).toHaveBeenCalledTimes(1),
            )

            const onTransaction = getListener('transaction')
            expect(onTransaction).toBeDefined()

            // A USDT-denominated transaction event (e.g. an incoming chat
            // ecash payment claimed by the bridge) refreshes the balance
            act(() => {
                onTransaction({
                    federationId: usdtFederation.id,
                    transaction: { unit: 'usdt' },
                })
            })
            await waitFor(() =>
                expect(fedimint.usdtBalance).toHaveBeenCalledTimes(2),
            )

            // Bitcoin transactions and other federations' events do not
            act(() => {
                onTransaction({
                    federationId: usdtFederation.id,
                    transaction: { unit: 'bitcoin' },
                })
                onTransaction({
                    federationId: 'some-other-federation',
                    transaction: { unit: 'usdt' },
                })
            })
            expect(fedimint.usdtBalance).toHaveBeenCalledTimes(2)
        })

        it('ignores pending deposit events but refreshes on claimed', async () => {
            const { fedimint, getListener } = renderMonitor()

            await waitFor(() =>
                expect(fedimint.usdtBalance).toHaveBeenCalledTimes(1),
            )

            const onDeposit = getListener('usdtDeposit')
            expect(onDeposit).toBeDefined()

            // `pending` = detected on-chain, nothing credited yet
            act(() => {
                onDeposit({
                    federationId: usdtFederation.id,
                    address: '0xabc',
                    state: { type: 'pending', amount: 1_000_000 },
                })
            })
            expect(fedimint.usdtBalance).toHaveBeenCalledTimes(1)

            act(() => {
                onDeposit({
                    federationId: usdtFederation.id,
                    address: '0xabc',
                    state: { type: 'claimed', amount: 1_000_000 },
                })
            })
            await waitFor(() =>
                expect(fedimint.usdtBalance).toHaveBeenCalledTimes(2),
            )
        })
    })
})
