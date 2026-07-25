import { formatNotificationAmount } from '../../../utils/notifications'

describe('notifications utils', () => {
    describe('formatNotificationAmount', () => {
        it('formats usdt amounts (micros) via formatUsdtMicros, unlabeled', () => {
            expect(
                formatNotificationAmount({ amount: 5_000_000, unit: 'usdt' }),
            ).toEqual({ formattedNumber: '5.00', unit: 'usdt' })
            expect(
                formatNotificationAmount({ amount: 1_500_000, unit: 'usdt' }),
            ).toEqual({ formattedNumber: '1.50', unit: 'usdt' })
        })

        it('formats bitcoin amounts (msats) as whole sats, unlabeled', () => {
            // 5,000,000 msats == 5,000 sats
            expect(
                formatNotificationAmount({
                    amount: 5_000_000,
                    unit: 'bitcoin',
                }),
            ).toEqual({ formattedNumber: '5,000', unit: 'sats' })
            expect(
                formatNotificationAmount({ amount: 1_000, unit: 'bitcoin' }),
            ).toEqual({ formattedNumber: '1', unit: 'sats' })
        })

        it('returns undefined for an unknown/unstamped unit', () => {
            expect(
                formatNotificationAmount({ amount: 5_000_000, unit: 'other' }),
            ).toBeUndefined()
        })
    })
})
