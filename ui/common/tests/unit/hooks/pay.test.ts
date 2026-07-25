import { act, waitFor } from '@testing-library/react'

import { useClaimEcash, useParseEcash } from '../../../hooks/pay'
import {
    selectUsdtBalanceMicros,
    setFederations,
    setupStore,
} from '../../../redux'
import { LoadedFederation, MSats } from '../../../types'
import { RpcEcashInfo, RpcFederationPreview } from '../../../types/bindings'
import * as FederationUtils from '../../../utils/FederationUtils'
import {
    createMockFederationPreview,
    mockFederation1,
} from '../../mock-data/federation'
import { createMockFedimintBridge } from '../../utils/fedimint'
import { renderHookWithState } from '../../utils/render'

const NOT_JOINED_TOKEN = 'token-not-joined'
const JOINED_TOKEN = 'token-joined'

const buildNotJoinedEcash = (): RpcEcashInfo => ({
    federation_type: 'notJoined',
    federation_invite: 'invite-code',
    amount: 10000 as MSats,
    unit: 'bitcoin',
})

const buildJoinedEcash = (): RpcEcashInfo => ({
    federation_type: 'joined',
    federation_id: mockFederation1.id,
    amount: 10000 as MSats,
    unit: 'bitcoin',
})

const buildJoinedUsdtEcash = (): RpcEcashInfo => ({
    federation_type: 'joined',
    federation_id: mockFederation1.id,
    amount: 5_000_000 as MSats,
    unit: 'usdt',
})

describe('common/hooks/pay', () => {
    describe('useParseEcash › newMembersDisabled', () => {
        let store: ReturnType<typeof setupStore>
        let getPreviewSpy: jest.SpyInstance

        beforeEach(() => {
            store = setupStore()
            jest.clearAllMocks()
            getPreviewSpy = jest.spyOn(FederationUtils, 'getFederationPreview')
        })

        afterEach(() => {
            getPreviewSpy.mockRestore()
        })

        const renderWithPreview = (
            ecash: RpcEcashInfo,
            preview: RpcFederationPreview | null,
        ) => {
            const fedimint = createMockFedimintBridge({
                parseEcash: Promise.resolve(ecash),
            })
            if (preview) {
                getPreviewSpy.mockResolvedValue(preview)
            }
            return renderHookWithState(() => useParseEcash(), store, fedimint)
        }

        it('should flag new members as disabled when preview meta opts out of joining', async () => {
            const { result } = renderWithPreview(
                buildNotJoinedEcash(),
                createMockFederationPreview({
                    meta: { new_members_disabled: 'true' },
                }),
            )

            await act(() => result.current.parseEcash(NOT_JOINED_TOKEN))

            await waitFor(() => {
                expect(result.current.loading).toBe(false)
                expect(result.current.newMembersDisabled).toBe(true)
            })
        })

        it('should treat preview without new_members_disabled meta as joinable', async () => {
            const { result } = renderWithPreview(
                buildNotJoinedEcash(),
                createMockFederationPreview({ meta: {} }),
            )

            await act(() => result.current.parseEcash(NOT_JOINED_TOKEN))

            await waitFor(() => {
                expect(result.current.loading).toBe(false)
                expect(result.current.newMembersDisabled).toBe(false)
            })
        })

        it('should not flag joined federations regardless of meta', async () => {
            store.dispatch(
                setFederations([
                    {
                        ...mockFederation1,
                        meta: { new_members_disabled: 'true' },
                    } as LoadedFederation,
                ]),
            )
            const { result } = renderWithPreview(buildJoinedEcash(), null)

            await act(() => result.current.parseEcash(JOINED_TOKEN))

            await waitFor(() => {
                expect(result.current.loading).toBe(false)
                expect(result.current.newMembersDisabled).toBe(false)
            })
        })

        it('should default to false before any token is parsed', () => {
            const fedimint = createMockFedimintBridge()
            const { result } = renderHookWithState(
                () => useParseEcash(),
                store,
                fedimint,
            )

            expect(result.current.newMembersDisabled).toBe(false)
        })
    })

    describe('useClaimEcash › unit routing', () => {
        let store: ReturnType<typeof setupStore>

        beforeEach(() => {
            store = setupStore()
            jest.clearAllMocks()
        })

        it('redeems usdt-denominated notes via usdtReceiveEcash, not the bitcoin receiveEcash thunk, and refreshes the usdt balance', async () => {
            const fedimint = createMockFedimintBridge({
                usdtReceiveEcash: Promise.resolve(5_000_000),
                usdtBalance: Promise.resolve(5_000_000),
                receiveEcash: Promise.resolve([0, 'op-id']),
            })
            const { result } = renderHookWithState(
                () => useClaimEcash(),
                store,
                fedimint,
            )

            await act(() =>
                result.current.claimEcash(buildJoinedUsdtEcash(), 'usdt-token'),
            )

            await waitFor(() => {
                expect(result.current.claimed).toBe(true)
                expect(result.current.isError).toBe(false)
            })

            expect(fedimint.usdtReceiveEcash).toHaveBeenCalledWith(
                'usdt-token',
                mockFederation1.id,
            )
            expect(fedimint.receiveEcash).not.toHaveBeenCalled()

            await waitFor(() => {
                expect(
                    selectUsdtBalanceMicros(
                        store.getState(),
                        mockFederation1.id,
                    ),
                ).toBe(5_000_000)
            })
        })
    })
})
