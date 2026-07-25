import { waitFor } from '@testing-library/react'
import { TFunction } from 'i18next'

import {
    useMatrixPaymentEvent,
    useMatrixPaymentTransaction,
} from '../../../hooks/matrix'
import {
    claimMatrixPayment,
    sendMatrixPaymentPush,
    sendMatrixPaymentRequest,
    setFederations,
    setMatrixAuth,
    setupStore,
    tryReclaimMatrixPayment,
} from '../../../redux'
import {
    LoadedFederation,
    MatrixAuth,
    MatrixPaymentEvent,
    MatrixRoom,
} from '../../../types'
import { RpcEcashUnit, RpcTimelineEventItemId } from '../../../types/bindings'
import { BridgeError } from '../../../utils/errors'
import {
    consolidatePaymentEvents,
    getReceivablePaymentEvents,
    makeMatrixPaymentText,
} from '../../../utils/matrix'
import { formatUsdtMicros } from '../../../utils/usdt'
import { mockFederation1 } from '../../mock-data/federation'
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
// Wire-Format Lock: sendMatrixPaymentPush / sendMatrixPaymentRequest
// (unit: 'usdt')
// Business Context: the `xyz.fedi.payment` message `content` the USDT
// branch of these thunks produces is a wire format — old Fedi clients (and
// the receiving side of this same client, in
// `claimMatrixPayment`/`getPaymentUnit`) parse these exact fields. This
// locks the exact shape from BEFORE the (former) standalone
// `sendMatrixUsdtPaymentPush`/`sendMatrixUsdtPaymentRequest` thunks were
// merged into their BTC counterparts as a single unit-parameterized pair,
// so any accidental field rename/drop/reshape during that refactor fails
// loudly here instead of silently breaking cross-version chat payments.
*/
describe('wire-format lock: USDT payment message content', () => {
    it("sendMatrixPaymentPush(unit: 'usdt') produces the exact message content", async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1sender' } as MatrixAuth),
        )
        store.dispatch(
            setFederations([mockFederation1] as unknown as LoadedFederation[]),
        )

        const sendMessage = jest.fn().mockResolvedValue(undefined)
        const usdtGenerateEcash = jest.fn().mockResolvedValue({
            ecash: 'mock-ecash-token',
            operationId: 'op-123',
        })
        const fedimint = {
            getMatrixClient: () => ({ sendMessage }),
            usdtGenerateEcash,
            usdtBalance: jest.fn().mockResolvedValue(0),
        } as any

        const roomId = 'room-a' as MatrixRoom['id']

        const senderOperationId = await store
            .dispatch(
                sendMatrixPaymentPush({
                    fedimint,
                    federationId: mockFederation1.id,
                    roomId,
                    recipientId: 'npub1recipient',
                    amount: 1_500_000,
                    unit: 'usdt',
                    notes: 'lunch',
                }),
            )
            .unwrap()

        expect(senderOperationId).toBe('op-123')
        expect(usdtGenerateEcash).toHaveBeenCalledWith(
            1_500_000,
            mockFederation1.id,
            true, // shouldShowInviteCode(meta: {}) === true
            {
                recipientMatrixId: 'npub1recipient',
                senderMatrixId: 'npub1sender',
                initialNotes: 'lunch',
            },
        )

        expect(sendMessage).toHaveBeenCalledTimes(1)
        const [calledRoomId, content] = sendMessage.mock.calls[0]
        expect(calledRoomId).toBe(roomId)

        const { paymentId, ...rest } = content as Record<string, unknown>
        expect(typeof paymentId).toBe('string')
        expect((paymentId as string).length).toBeGreaterThan(0)

        expect(rest).toEqual({
            msgtype: 'xyz.fedi.payment',
            body: 'Sent payment of 1.50 USDT. Use the Fedi app to accept this payment.',
            status: 'pushed',
            senderOperationId: 'op-123',
            senderId: 'npub1sender',
            recipientId: 'npub1recipient',
            amount: 1_500_000,
            unit: 'usdt',
            ecash: 'mock-ecash-token',
            federationId: mockFederation1.id,
            inviteCode: mockFederation1.inviteCode,
        })
    })

    it("sendMatrixPaymentRequest(unit: 'usdt') produces the exact message content", async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1requester' } as MatrixAuth),
        )

        const sendMessage = jest.fn().mockResolvedValue(undefined)
        const fedimint = {
            getMatrixClient: () => ({ sendMessage }),
        } as any

        const roomId = 'room-a' as MatrixRoom['id']

        await store
            .dispatch(
                sendMatrixPaymentRequest({
                    fedimint,
                    federationId: mockFederation1.id,
                    roomId,
                    amount: 2_000_000,
                    unit: 'usdt',
                }),
            )
            .unwrap()

        expect(sendMessage).toHaveBeenCalledTimes(1)
        const [calledRoomId, content] = sendMessage.mock.calls[0]
        expect(calledRoomId).toBe(roomId)

        const { paymentId, ...rest } = content as Record<string, unknown>
        expect(typeof paymentId).toBe('string')
        expect((paymentId as string).length).toBeGreaterThan(0)

        expect(rest).toEqual({
            msgtype: 'xyz.fedi.payment',
            body: 'Requested payment of 2.00 USDT. Use the Fedi app to complete this request.',
            status: 'requested',
            recipientId: 'npub1requester',
            amount: 2_000_000,
            unit: 'usdt',
            federationId: mockFederation1.id,
        })
    })
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

/*
// USDT Reclaim Guard Tests
// Business Context: `tryReclaimMatrixPayment` is dispatched by the debounced
// timeline listener (`checkForReceivablePayments`) any time a rejected
// payment is seen, and its `.catch` frees the paymentId for retry on any
// thrown error. If the USDT notes were already redeemed back to us in a
// prior session (e.g. the app restarted before persisting that fact), the
// bridge's in-memory "already spent" tracking makes every retry fail
// forever, spamming failed bridge redeems on every poll. The bridge signals
// this specific case as a plain rejection message (no ErrorCode) from
// `usdt_receive_ecash` in crates/federations/src/federation_v2/usdt.rs:348 —
// "e-cash was rejected (possibly already spent)" — which must be treated as
// a successful reclaim, while other (e.g. transport) errors must still be
// rethrown so the payment remains eligible for retry.
*/
describe('tryReclaimMatrixPayment USDT reclaim guard', () => {
    const buildRejectedUsdtEvent = () =>
        createMockPaymentEvent({
            content: {
                unit: 'usdt',
                status: 'rejected',
                amount: 1_000_000,
                ecash: 'mock-ecash-token',
                federationId: 'fed123',
                senderOperationId: 'sender-op-123',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

    it('treats an already-spent rejection from usdtReceiveEcash as a successful reclaim, so the retry guard never re-attempts it', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const alreadySpentError = new BridgeError({
            error: 'e-cash was rejected (possibly already spent)',
            detail: 'e-cash was rejected (possibly already spent)',
            errorCode: null,
        })

        const usdtReceiveEcash = jest.fn().mockRejectedValue(alreadySpentError)
        const fedimint = {
            usdtReceiveEcash,
            usdtBalance: jest.fn().mockResolvedValue(0),
        } as any

        const event = buildRejectedUsdtEvent()

        // resolves (does not throw) even though the bridge call rejected
        await expect(
            store
                .dispatch(tryReclaimMatrixPayment({ fedimint, event }))
                .unwrap(),
        ).resolves.toBeUndefined()

        expect(usdtReceiveEcash).toHaveBeenCalledTimes(1)

        // This mirrors the exact guard `checkForReceivablePayments` runs
        // around every dispatch of `tryReclaimMatrixPayment` (see
        // ui/common/redux/matrix.ts: the `reclaimablePayments.forEach`
        // block): add the paymentId to a shared Set before dispatching, and
        // only delete it (permitting a retry) if the thunk's `.unwrap()`
        // rejects. Because our fixed thunk does NOT reject for the
        // already-spent case, the guard keeps the paymentId marked handled
        // forever, so a second poll of the same rejected event dispatches
        // nothing further.
        const receivedPayments = new Set<string>()
        const attemptReclaim = async () => {
            if (receivedPayments.has(event.content.paymentId)) return
            receivedPayments.add(event.content.paymentId)
            await store
                .dispatch(tryReclaimMatrixPayment({ fedimint, event }))
                .unwrap()
                .catch(() => {
                    receivedPayments.delete(event.content.paymentId)
                })
        }

        await attemptReclaim() // 2nd usdtReceiveEcash call, guard now holds the id
        await attemptReclaim() // guarded — must NOT call usdtReceiveEcash again

        expect(usdtReceiveEcash).toHaveBeenCalledTimes(2)
    })

    it('rethrows a non-already-spent (transport) error so the payment remains eligible for retry', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const transportError = new BridgeError({
            error: 'network request failed',
            detail: 'network request failed',
            errorCode: null,
        })

        const usdtReceiveEcash = jest.fn().mockRejectedValue(transportError)
        const fedimint = {
            usdtReceiveEcash,
            usdtBalance: jest.fn().mockResolvedValue(0),
        } as any

        const event = buildRejectedUsdtEvent()

        // RTK's `.unwrap()` throws the serialized error (a plain object,
        // not an `Error` instance), so `.rejects.toThrow()` can't recognize
        // it — same reason `tests/unit/redux/wallet.test.ts` uses
        // `.rejects.toBeDefined()` for the equivalent BTC-side assertion.
        await expect(
            store
                .dispatch(tryReclaimMatrixPayment({ fedimint, event }))
                .unwrap(),
        ).rejects.toBeDefined()

        expect(usdtReceiveEcash).toHaveBeenCalledTimes(1)
    })
})

// BUSINESS: the BTC reclaim path must keep its existing tolerance — a failed
// `cancelEcash` (e.g. notes already reclaimed in a prior session) must not
// make `tryReclaimMatrixPayment` throw, since `checkForReceivablePayments`
// would otherwise free the paymentId and retry forever, same as the USDT bug
// this change fixes. This is a regression guard: the BTC branch dispatches
// `cancelEcash` without awaiting/unwrapping it, so it was already immune to
// this pattern before this change — this test only verifies that stays true.
describe('tryReclaimMatrixPayment BTC reclaim path (untouched by this change)', () => {
    it('resolves without throwing even when the underlying cancelEcash bridge call fails', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const cancelEcashError = new BridgeError({
            error: 'Ecash cancel failed, the e-cash notes have been spent by someone else already',
            detail: 'Ecash cancel failed, the e-cash notes have been spent by someone else already',
            errorCode: 'ecashCancelFailed',
        })

        const cancelEcash = jest.fn().mockRejectedValue(cancelEcashError)
        const parseEcash = jest.fn().mockResolvedValue({
            federation_type: 'joined',
            federation_id: 'fed123',
            amount: 1000,
        })
        const getTransaction = jest.fn().mockResolvedValue({ kind: 'oobSend' })
        const fedimint = {
            cancelEcash,
            parseEcash,
            getTransaction,
        } as any

        const event = createMockPaymentEvent({
            content: {
                status: 'rejected',
                amount: 1000,
                ecash: 'mock-ecash-token',
                federationId: 'fed123',
                senderOperationId: 'sender-op-123',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        await expect(
            store
                .dispatch(tryReclaimMatrixPayment({ fedimint, event }))
                .unwrap(),
        ).resolves.toBeUndefined()

        expect(getTransaction).toHaveBeenCalledWith('fed123', 'sender-op-123')
    })
})

/*
// Unsupported Ecash Unit Tests
// Business Context: `RpcEcashUnit` already includes 'other', and future app
// versions may add units this build doesn't know about. Every chat-payment
// code path branched on `unit === 'usdt'`, so an unrecognized unit silently
// fell through to the bitcoin branch: micros formatted and displayed as
// sats, and auto-claim attempted via the BTC `receiveEcash` RPC on a token
// it can't actually parse. `getPaymentUnit` normalizes `unit` so every
// branch treats anything besides 'bitcoin'/'usdt' as 'unsupported': no
// auto-claim, no accept button, and the bubble shows a dedicated string
// instead of a misleading sats amount.
*/

// BUSINESS: a payment denominated in a unit this app version doesn't
// understand must never be rendered as a sats amount
describe('makeMatrixPaymentText unsupported ecash unit', () => {
    it('renders the unsupported-unit string instead of formatting the amount as sats', () => {
        const t = jest.fn((key: string) => key) as unknown as TFunction
        const event = createMockPaymentEvent({
            content: {
                unit: 'other',
                status: 'pushed',
                amount: 1000,
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        const result = makeMatrixPaymentText({
            t,
            event,
            myId: 'npub1recipient',
            eventSender: null,
            paymentSender: null,
            paymentRecipient: null,
            transaction: null,
            ...noopAmountFormatters,
            verifiedAmountMicros: undefined,
        })

        expect(result).toBe('feature.chat.unsupported-payment-unit')
        // exactly one `t` call, with no second (interpolation) argument —
        // in particular, never a sats-formatted amount
        expect(t).toHaveBeenCalledTimes(1)
        expect(t).toHaveBeenCalledWith('feature.chat.unsupported-payment-unit')
    })
})

// BUSINESS: the auto-claim loop must never attempt to redeem ecash in a
// unit it doesn't understand
describe('unsupported ecash unit auto-claim eligibility', () => {
    it('excludes an unsupported-unit payment from getReceivablePaymentEvents, even when otherwise eligible', () => {
        const event = createMockPaymentEvent({
            content: {
                unit: 'other',
                status: 'pushed',
                amount: 1000,
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
                federationId: 'fed123',
            },
        })

        const receivable = getReceivablePaymentEvents(
            [event],
            'npub1recipient',
            [{ id: 'fed123', recovering: false } as any],
        )

        expect(receivable).toHaveLength(0)
    })

    it('claimMatrixPayment (the auto-claim dispatch) makes zero receiveEcash/usdtReceiveEcash calls for an unsupported unit', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const roomId = 'room-a' as MatrixRoom['id']
        const event = createMockPaymentEvent({
            roomId,
            content: {
                unit: 'other',
                status: 'pushed',
                amount: 1000,
                ecash: 'mock-ecash-token',
                federationId: 'fed123',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        const sendMessage = jest.fn().mockResolvedValue(undefined)
        const markRoomAsUnread = jest.fn().mockResolvedValue(undefined)
        const receiveEcash = jest.fn().mockResolvedValue(['note', 'op-123'])
        const usdtReceiveEcash = jest.fn().mockResolvedValue(1)
        const fedimint = {
            getMatrixClient: () => ({ sendMessage, markRoomAsUnread }),
            receiveEcash,
            usdtReceiveEcash,
            usdtBalance: jest.fn().mockResolvedValue(0),
        } as any

        await expect(
            store.dispatch(claimMatrixPayment({ fedimint, event })).unwrap(),
        ).rejects.toBeDefined()

        expect(receiveEcash).not.toHaveBeenCalled()
        expect(usdtReceiveEcash).not.toHaveBeenCalled()
        expect(sendMessage).not.toHaveBeenCalled()
    })
})

// BUSINESS: regression guard — payments with no `unit` field (old-sender
// compatibility) or `unit: 'bitcoin'` must keep behaving exactly as before
// this change, both for display and for claiming
describe('undefined/bitcoin unit regression (unaffected by this change)', () => {
    it('makeMatrixPaymentText renders the normal sats payment text, not the unsupported string', () => {
        const t = jest.fn((key: string) => key) as unknown as TFunction
        const event = createMockPaymentEvent({
            content: {
                unit: undefined,
                status: 'pushed',
                amount: 1000,
                ecash: 'mock-ecash-token',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        const result = makeMatrixPaymentText({
            t,
            event,
            myId: 'npub1recipient',
            eventSender: null,
            paymentSender: null,
            paymentRecipient: null,
            transaction: null,
            makeFormattedAmountsFromMSats: jest.fn().mockReturnValue({
                formattedFiat: '$0.50',
                formattedSats: '1,000',
                formattedUsd: '$0.50',
                formattedPrimaryAmount: '$0.50',
                formattedSecondaryAmount: '1,000 SATS',
            }),
            makeFormattedAmountsFromTxn: jest.fn(),
            verifiedAmountMicros: undefined,
        })

        expect(result).toBe('feature.chat.they-sent-payment')
        expect(t).not.toHaveBeenCalledWith(
            'feature.chat.unsupported-payment-unit',
        )
    })

    it('claimMatrixPayment still redeems via the BTC receiveEcash RPC for an undefined unit', async () => {
        const store = setupStore()
        store.dispatch(
            setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
        )

        const roomId = 'room-a' as MatrixRoom['id']
        const event = createMockPaymentEvent({
            roomId,
            content: {
                unit: undefined,
                status: 'pushed',
                amount: 1000,
                ecash: 'mock-ecash-token',
                federationId: 'fed123',
                senderId: 'npub1sender',
                recipientId: 'npub1recipient',
            },
        })

        const sendMessage = jest.fn().mockResolvedValue(undefined)
        const markRoomAsUnread = jest.fn().mockResolvedValue(undefined)
        const receiveEcash = jest.fn().mockResolvedValue(['note', 'op-123'])
        const usdtReceiveEcash = jest.fn()
        const fedimint = {
            getMatrixClient: () => ({ sendMessage, markRoomAsUnread }),
            receiveEcash,
            usdtReceiveEcash,
        } as any

        await store.dispatch(claimMatrixPayment({ fedimint, event })).unwrap()

        expect(receiveEcash).toHaveBeenCalledWith(
            'mock-ecash-token',
            'fed123',
            expect.anything(),
        )
        expect(usdtReceiveEcash).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalledWith(
            roomId,
            expect.objectContaining({ status: 'received' }),
        )
    })
})

/*
// useMatrixPaymentEvent Button Derivation Tests
// Business Context: `useMatrixPaymentEvent` is the hook backing the chat
// payment bubble's action buttons. Two spots hide the accept/pay button for
// a payment denominated in an ecash unit this app version doesn't
// understand (`getPaymentUnit(...) === 'unsupported'`): the incoming-push
// "accept via foreign ecash" flow, and the incoming-request "pay" flow. Both
// must fall through to their normal (reject-only or empty) button set
// instead of offering an action the app can't fulfill, while 'usdt' and
// legacy (`unit: undefined`) payments must be completely unaffected.
*/

const noopT = jest.fn((key: string) => key) as unknown as TFunction

describe('useMatrixPaymentEvent unsupported-unit button hiding', () => {
    // covers ui/common/hooks/matrix.ts ~771-775: the incoming-push branch
    // taken when the recipient hasn't joined the paying federation
    // (`!canClaimPayment`), which otherwise offers reject + "accept via
    // foreign ecash" buttons
    describe('incoming push, not-yet-joined federation (foreign-ecash accept flow)', () => {
        const buildPushEvent = (unit: RpcEcashUnit | undefined) =>
            createMockPaymentEvent({
                content: {
                    unit,
                    status: 'pushed',
                    amount: 1000,
                    senderId: 'npub1sender',
                    recipientId: 'npub1recipient',
                    federationId: 'fed-not-joined',
                },
            })

        it('excludes the accept (and reject) buttons for an unsupported unit', async () => {
            const store = setupStore()
            store.dispatch(
                setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
            )
            const mockFedimint = createMockFedimintBridge()

            const { result } = renderHookWithState(
                () =>
                    useMatrixPaymentEvent({
                        event: buildPushEvent('other'),
                        t: noopT,
                        onError: jest.fn(),
                    }),
                store,
                mockFedimint,
            )

            await waitFor(() => {
                expect(result.current.isLoadingTransaction).toBe(false)
            })

            expect(result.current.buttons).toEqual([])
        })

        it.each<RpcEcashUnit | undefined>(['usdt', undefined])(
            'regression: keeps the accept button for unit=%s',
            async unit => {
                const store = setupStore()
                store.dispatch(
                    setMatrixAuth({ userId: 'npub1recipient' } as MatrixAuth),
                )
                const mockFedimint = createMockFedimintBridge()

                const { result } = renderHookWithState(
                    () =>
                        useMatrixPaymentEvent({
                            event: buildPushEvent(unit),
                            t: noopT,
                            onError: jest.fn(),
                        }),
                    store,
                    mockFedimint,
                )

                await waitFor(() => {
                    expect(result.current.isLoadingTransaction).toBe(false)
                })

                expect(result.current.buttons.map(b => b.label)).toEqual([
                    'words.reject',
                    'words.accept',
                ])
            },
        )
    })

    // covers ui/common/hooks/matrix.ts ~845-855: the incoming-request
    // branch, which otherwise offers a "pay" button (and a "reject" button
    // in DMs)
    describe('incoming request (pay flow)', () => {
        const buildRequestEvent = (unit: RpcEcashUnit | undefined) =>
            createMockPaymentEvent({
                content: {
                    unit,
                    status: 'requested',
                    amount: 1000,
                    senderId: 'npub1requester',
                    recipientId: 'npub1requester',
                    federationId: 'fed-not-joined',
                },
            })

        it('excludes the pay button for an unsupported unit', async () => {
            const store = setupStore()
            store.dispatch(
                setMatrixAuth({ userId: 'npub1me' } as MatrixAuth),
            )
            const mockFedimint = createMockFedimintBridge()

            const { result } = renderHookWithState(
                () =>
                    useMatrixPaymentEvent({
                        event: buildRequestEvent('other'),
                        t: noopT,
                        onError: jest.fn(),
                    }),
                store,
                mockFedimint,
            )

            await waitFor(() => {
                expect(result.current.isLoadingTransaction).toBe(false)
            })

            // not a DM (no room loaded), so no reject button either — the
            // unsupported unit leaves nothing to offer
            expect(result.current.buttons).toEqual([])
        })

        it.each<RpcEcashUnit | undefined>(['usdt', undefined])(
            'regression: keeps the pay button for unit=%s',
            async unit => {
                const store = setupStore()
                store.dispatch(
                    setMatrixAuth({ userId: 'npub1me' } as MatrixAuth),
                )
                const mockFedimint = createMockFedimintBridge()

                const { result } = renderHookWithState(
                    () =>
                        useMatrixPaymentEvent({
                            event: buildRequestEvent(unit),
                            t: noopT,
                            onError: jest.fn(),
                        }),
                    store,
                    mockFedimint,
                )

                await waitFor(() => {
                    expect(result.current.isLoadingTransaction).toBe(false)
                })

                expect(result.current.buttons.map(b => b.label)).toEqual([
                    'words.pay',
                ])
            },
        )
    })
})
