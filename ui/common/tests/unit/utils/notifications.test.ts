import { formatNotificationAmount } from '../../../utils/notifications'

describe('notifications utils', () => {
    describe('formatNotificationAmount', () => {
        it('formats usdt amounts (micros) via formatUsdtMicros', () => {
            expect(
                formatNotificationAmount({ amount: 5_000_000, unit: 'usdt' }),
            ).toBe('5.00 USDT')
            expect(
                formatNotificationAmount({ amount: 1_500_000, unit: 'usdt' }),
            ).toBe('1.50 USDT')
        })

        it('formats bitcoin amounts (msats) as whole sats', () => {
            // 5,000,000 msats == 5,000 sats
            expect(
                formatNotificationAmount({
                    amount: 5_000_000,
                    unit: 'bitcoin',
                }),
            ).toBe('5,000 SATS')
            expect(
                formatNotificationAmount({ amount: 1_000, unit: 'bitcoin' }),
            ).toBe('1 SATS')
        })

        it('returns undefined for an unknown/unstamped unit', () => {
            expect(
                formatNotificationAmount({ amount: 5_000_000, unit: 'other' }),
            ).toBeUndefined()
        })
    })
})
