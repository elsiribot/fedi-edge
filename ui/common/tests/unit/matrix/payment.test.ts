import { waitFor } from '@testing-library/react'
import { TFunction } from 'i18next'

import { useMatrixPaymentTransaction } from '../../../hooks/matrix'
import { claimMatrixPayment, setMatrixAuth, setupStore } from '../../../redux'
import { MatrixAuth, MatrixPaymentEvent, MatrixRoom } from '../../../types'
import { RpcTimelineEventItemId } from '../../../types/bindings'
import {
    consolidatePaymentEvents,
    makeMatrixPaymentText,
} from '../../../utils/matrix'
import { formatUsdtMicros } from '../../../utils/usdt'
import {
    createMockPaymentEvent,
    createMockNonPaymentEvent,
} from '../../mock-data/matrix-event'
import { createMockFedimintBridge } from '../../utils/fedimint'
import { renderHookWithState } from '../../utils/render'

/*
// Payment Event Consolidation Tests
// Business Context: When users send payments, multiple events are created (push, accept, receive).
// The app needs to show only one message per payment while keeping it updated with the latest status.
// This ensures a clean chat experience without duplicate payment messages.
*/

// BUSINESS: App handles empty chat rooms gracefully
it('returns empty array when given empty input', () => {
    expect(consolidatePaymentEvents([])).toEqual([])
})

// BUSINESS: Regular text messages remain unchanged while payment events get special processing
it('keeps non-payment events unchanged', () => {
    const textEvent = createMockNonPaymentEvent({
        id: 'text1' as RpcTimelineEventItemId,
        timestamp: 1000,
    })
    const paymentEvent = createMockPaymentEvent({
        id: 'payment1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 2000,
        },
    })

    const result = consolidatePaymentEvents([textEvent, paymentEvent])

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(textEvent)
})

// BUSINESS: Users see only one message per payment (not 3 separate push/accept/receive messages)
it('shows only initial payment events (pushed/requested) for each paymentId', () => {
    const pushedEvent = createMockPaymentEvent({
        id: 'event1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 1000,
        },
    })
    const acceptedEvent = createMockPaymentEvent({
        id: 'event2' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'accepted',
            amount: 2000,
        },
    })
    const receivedEvent = createMockPaymentEvent({
        id: 'event3' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'received',
            amount: 3000,
        },
    })

    const result = consolidatePaymentEvents([
        pushedEvent,
        acceptedEvent,
        receivedEvent,
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('event1') // shows the initial pushed event
})

// BUSINESS: Payment message shows current status (completed/pending) not the original status
it('merges latest status into initial event content', () => {
    const pushedEvent = createMockPaymentEvent({
        id: 'event1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 1000,
            senderOperationId: 'sender-op-123',
        },
    })
    const receivedEvent = createMockPaymentEvent({
        id: 'event2' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'received',
            amount: 3000,
            senderOperationId: 'sender-op-123',
            receiverOperationId: 'receiver-op-456',
        },
    })

    const result = consolidatePaymentEvents([pushedEvent, receivedEvent])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('event1') // original event ID

    const paymentEvent = result[0] as MatrixPaymentEvent
    expect(paymentEvent.content.status).toBe('received') // updated status
    expect(paymentEvent.content.receiverOperationId).toBe('receiver-op-456') // merged data
})

// BUSINESS: App preserves transaction history links when older clients send incomplete updates
it('preserves existing operation IDs', () => {
    const pushedEvent = createMockPaymentEvent({
        id: 'event1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 1000,
            senderOperationId: 'sender-op-123',
            receiverOperationId: undefined,
        },
    })
    const updateEvent = createMockPaymentEvent({
        id: 'event2' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'accepted',
            amount: 2000,
            senderOperationId: 'sender-op-123',
            receiverOperationId: 'receiver-op-456',
        },
    })

    const result = consolidatePaymentEvents([pushedEvent, updateEvent])

    const paymentEvent = result[0] as MatrixPaymentEvent
    expect(paymentEvent.content.senderOperationId).toBe('sender-op-123')
    expect(paymentEvent.content.receiverOperationId).toBe('receiver-op-456')
})

// BUSINESS: USDT-denominated payments keep their unit (and micros amount)
// through status updates so the bubble keeps rendering "X.XX USDT"
it('preserves the usdt unit when merging latest status into initial event content', () => {
    const pushedEvent = createMockPaymentEvent({
        id: 'event1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 1_500_000, // USDT micros
            unit: 'usdt',
            senderOperationId: 'sender-op-123',
        },
    })
    const receivedEvent = createMockPaymentEvent({
        id: 'event2' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'received',
            amount: 1_500_000,
            unit: 'usdt',
            senderOperationId: 'sender-op-123',
        },
    })

    const result = consolidatePaymentEvents([pushedEvent, receivedEvent])

    expect(result).toHaveLength(1)
    const paymentEvent = result[0] as MatrixPaymentEvent
    expect(paymentEvent.content.status).toBe('received')
    expect(paymentEvent.content.unit).toBe('usdt')
    expect(paymentEvent.content.amount).toBe(1_500_000)
})

// BUSINESS: Multiple payments in same chat are handled independently
it('handles multiple different payment IDs correctly', () => {
    const payment1Event = createMockPaymentEvent({
        id: 'event1' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'pushed',
            amount: 1000,
        },
    })
    const payment2Event = createMockPaymentEvent({
        id: 'event2' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay456',
            status: 'requested',
            amount: 2000,
        },
    })
    const payment1Update = createMockPaymentEvent({
        id: 'event3' as RpcTimelineEventItemId,
        content: {
            paymentId: 'pay123',
            status: 'received',
            amount: 3000,
        },
    })

    const result = consolidatePaymentEvents([
        payment1Event,
        payment2Event,
        payment1Update,
    ])

    expect(result).toHaveLength(2)

    const payment1Result = result.find(e => {
        return (
            e.content.msgtype === 'xyz.fedi.payment' &&
            (e.content as any).paymentId === 'pay123'
        )
    }) as MatrixPaymentEvent

    const payment2Result = result.find(e => {
        return (
            e.content.msgtype === 'xyz.fedi.payment' &&
            (e.content as any).paymentId === 'pay456'
        )
    }) as MatrixPaymentEvent

    expect(payment1Result.content.status).toBe('received')
    expect(payment2Result.content.status).toBe('requested')
})

/*
// USDT Payment Amount Verification Tests
// Business Context: a chat payment message carries a sender-declared `amount`
// alongside (for pushes) an attached `ecash` token. A malicious sender could
// declare an arbitrarily large amount while attaching a nearly-worthless
// note. The UI must never render the sender-declared amount for a push once
// the actual ecash can be verified — display must reflect the real,
// bridge-verified value.
*/

const noopAmountFormatters = {
    makeFormattedAmountsFromMSats: jest.fn(),
    makeFormattedAmountsFromTxn: jest.fn(),
}

// BUSINESS: the payment bubble must show what the ecash is actually worth,
// not whatever amount the sender put in the message body
describe('makeMatrixPaymentText USDT amount verification', () => {
    it('renders the validated ecash amount instead of the sender-declared amount when they mismatch', () => {
        const t = jest.fn((key: string) => key) as unknown as TFunction
        const event = createMockPaymentEvent({
            content: {
                unit: 'usdt',
                status: 'pushed',
                amount: 1_000_000_000, // sender declares 1,000 USDT
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        makeMatrixPaymentText({
            t,
            event,
            myId: 'npub1recipient',
            eventSender: null,
            paymentSender: null,
            paymentRecipient: null,
            transaction: null,
            ...noopAmountFormatters,
            // fedimint.parseEcash verified the note is only worth 1 micro
            verifiedAmountMicros: 1,
        })

        expect(formatUsdtMicros(1)).toBe('0.000001 USDT')

        expect(t).toHaveBeenCalledWith(
            'feature.usdt.they-sent-payment',
            expect.objectContaining({ amount: '0.000001 USDT' }),
        )
        // must NOT render the sender-declared amount
        expect(t).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                amount: expect.stringContaining('1,000'),
            }),
        )
    })

    it('falls back to the declared amount for requests, which have no ecash to verify', () => {
        const t = jest.fn((key: string) => key) as unknown as TFunction
        const event = createMockPaymentEvent({
            sender: 'npub1recipient',
            content: {
                unit: 'usdt',
                status: 'requested',
                amount: 2_000_000, // 2.00 USDT requested
                ecash: undefined,
                senderId: 'npub1recipient',
                recipientId: 'npub1recipient',
            },
        })

        makeMatrixPaymentText({
            t,
            event,
            myId: 'npub1recipient',
            eventSender: null,
            paymentSender: null,
            paymentRecipient: null,
            transaction: null,
            ...noopAmountFormatters,
            // hook sets this to null for requests (nothing to verify)
            verifiedAmountMicros: null,
        })

        expect(t).toHaveBeenCalledWith(
            'feature.usdt.you-requested-payment',
            expect.objectContaining({ amount: '2.00 USDT' }),
        )
    })
})

// BUSINESS: the hook backing the payment bubble verifies USDT ecash against
// the bridge rather than trusting the message body
describe('useMatrixPaymentTransaction USDT ecash verification', () => {
    it('surfaces the amount validateEcash reports, not the declared amount', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const mockFedimint = createMockFedimintBridge({
            parseEcash: {
                federation_type: 'joined',
                federation_id: 'fed123',
                amount: 1, // only 1 micro, despite the 1,000,000,000-micro claim
                unit: 'usdt',
            },
        })

        const event = createMockPaymentEvent({
            content: {
                unit: 'usdt',
                status: 'pushed',
                amount: 1_000_000_000,
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
                federationId: 'fed123',
            },
        })

        const { result } = renderHookWithState(
            () => useMatrixPaymentTransaction({ event }),
            store,
            mockFedimint,
        )

        await waitFor(() => {
            expect(result.current.verifiedAmountMicros).toBe(1)
        })

        expect(mockFedimint.parseEcash).toHaveBeenCalledWith('mock-ecash-token')
        expect(result.current.transaction).toBeNull()
    })

    it('does not treat the declared amount as verified when validation fails (e.g. offline)', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const mockFedimint = createMockFedimintBridge({
            parseEcash: () => Promise.reject(new Error('offline')),
        })

        const event = createMockPaymentEvent({
            content: {
                unit: 'usdt',
                status: 'pushed',
                amount: 1_000_000_000,
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
                federationId: 'fed123',
            },
        })

        const { result } = renderHookWithState(
            () => useMatrixPaymentTransaction({ event }),
            store,
            mockFedimint,
        )

        await waitFor(() => {
            expect(result.current.hasTriedFetch).toBe(true)
        })

        // null (not the declared amount) — the caller falls back to the
        // declared amount display itself, same as the BTC branch does when
        // its transaction fetch fails, but the hook never claims it verified
        // a number it didn't
        expect(result.current.verifiedAmountMicros).toBeNull()
        expect(result.current.error).not.toBeNull()
    })

    it('marks requests (no ecash attached) as having nothing to verify, without calling validateEcash', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const mockFedimint = createMockFedimintBridge({
            parseEcash: jest.fn(),
        })

        const event = createMockPaymentEvent({
            content: {
                unit: 'usdt',
                status: 'requested',
                amount: 2_000_000,
                ecash: undefined,
                senderId: 'npub1recipient',
                recipientId: 'npub1recipient',
                federationId: 'fed123',
            },
        })

        const { result } = renderHookWithState(
            () => useMatrixPaymentTransaction({ event }),
            store,
            mockFedimint,
        )

        await waitFor(() => {
            expect(result.current.hasTriedFetch).toBe(true)
        })

        expect(result.current.verifiedAmountMicros).toBeNull()
        expect(mockFedimint.parseEcash).not.toHaveBeenCalled()
    })
})

// BUSINESS: once a USDT push is claimed, the chat bubble must reflect what
// was actually redeemed, not what the sender originally claimed to send
describe('claimMatrixPayment USDT redeemed amount', () => {
    it('uses the amount actually redeemed by usdtReceiveEcash in the post-claim status update', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const roomId = 'room-a' as MatrixRoom['id']
        const event = createMockPaymentEvent({
            roomId,
            content: {
                unit: 'usdt',
                status: 'pushed',
                amount: 1_000_000_000, // declared: 1,000 USDT
                ecash: 'mock-ecash-token',
                federationId: 'fed123',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        const redeemedAmountMicros = 1 // actual redeemed value: 1 micro
        const sendMessage = jest.fn().mockResolvedValue(undefined)
        const markRoomAsUnread = jest.fn().mockResolvedValue(undefined)
        const fedimint = {
            getMatrixClient: () => ({ sendMessage, markRoomAsUnread }),
            usdtReceiveEcash: jest.fn().mockResolvedValue(redeemedAmountMicros),
            usdtBalance: jest.fn().mockResolvedValue(0),
        } as any

        await store.dispatch(claimMatrixPayment({ fedimint, event })).unwrap()

        expect(fedimint.usdtReceiveEcash).toHaveBeenCalledWith(
            'mock-ecash-token',
            'fed123',
        )
        expect(sendMessage).toHaveBeenCalledWith(
            roomId,
            expect.objectContaining({
                status: 'received',
                amount: redeemedAmountMicros,
            }),
        )

        // and downstream, the consolidated event (what actually renders)
        // reflects the redeemed amount, not the sender-declared one
        const [, sentContent] = sendMessage.mock.calls[0]
        const receivedEvent = createMockPaymentEvent({
            id: 'event2' as RpcTimelineEventItemId,
            roomId,
            content: sentContent,
        })
        const [consolidated] = consolidatePaymentEvents([
            event,
            receivedEvent,
        ]) as MatrixPaymentEvent[]

        expect(consolidated.content.amount).toBe(redeemedAmountMicros)
        expect(consolidated.content.amount).not.toBe(1_000_000_000)
    })
})
