import {
    cleanup,
    screen,
    userEvent,
    waitFor,
} from '@testing-library/react-native'

import * as PayHooks from '@fedi/common/hooks/pay'
import {
    createMockFederationPreview,
    mockFederation1,
} from '@fedi/common/tests/mock-data/federation'
import { LoadedFederation, MSats } from '@fedi/common/types'
import i18n from '@fedi/native/localization/i18n'

import ClaimEcash from '../../../screens/ClaimEcash'
import { mockNavigation } from '../../setup/jest.setup.mocks'
import { renderWithProviders } from '../../utils/render'

let parseEcashSpy: jest.Mock
let claimEcashSpy: jest.Mock

describe('/screens/ClaimEcash', () => {
    const user = userEvent.setup()

    beforeEach(() => {
        // Create fresh spies for each test
        parseEcashSpy = jest.fn()
        claimEcashSpy = jest.fn()

        jest.spyOn(PayHooks, 'useParseEcash').mockImplementation(() => ({
            parseEcash: parseEcashSpy,
            loading: false,
            parsed: {
                amount: 10000 as MSats,
                federation_id: '1',
                federation_type: 'joined',
                unit: 'bitcoin',
            },
            ecashToken: '123',
            isError: false,
            federation: mockFederation1 as LoadedFederation,
            newMembersDisabled: false,
        }))

        jest.spyOn(PayHooks, 'useClaimEcash').mockImplementation(() => ({
            claimEcash: claimEcashSpy,
            loading: false,
            claimed: false,
            error: null,
            isError: false,
        }))
    })

    afterEach(() => {
        jest.restoreAllMocks()
        cleanup()
    })

    describe('When the screen loads', () => {
        it('should call the validateEcash function with the token value', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            await waitFor(() => {
                expect(parseEcashSpy).toHaveBeenCalledWith('123')
            })
        })

        it('should show correct amount in sats', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            const amount = await screen.findByText('10 SATS')
            expect(amount).toBeOnTheScreen()
        })
    })

    describe('when the user clicks on the claim ecash button', () => {
        it('should call claimEcash function correct params', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            const button = screen.getByTestId('claim-ecash-button')

            await user.press(button)

            expect(claimEcashSpy).toHaveBeenCalledWith(
                {
                    amount: 10000,
                    federation_id: '1',
                    federation_type: 'joined',
                    unit: 'bitcoin',
                },
                '123',
            )
        })
    })

    describe('when the issuing federation has new members disabled', () => {
        beforeEach(() => {
            jest.spyOn(PayHooks, 'useParseEcash').mockImplementation(() => ({
                parseEcash: parseEcashSpy,
                loading: false,
                parsed: {
                    amount: 10000 as MSats,
                    federation_invite: 'invite-code',
                    federation_type: 'notJoined',
                    unit: 'bitcoin',
                },
                ecashToken: '123',
                isError: false,
                federation: createMockFederationPreview({
                    meta: { new_members_disabled: 'true' },
                }),
                newMembersDisabled: true,
            }))
        })

        it('should explain that the ecash cannot be claimed', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            expect(
                await screen.findByText(
                    i18n.t('feature.ecash.claim-ecash-new-members-disabled'),
                ),
            ).toBeOnTheScreen()
        })

        it('should hide the claim ecash button', () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            expect(screen.queryByTestId('claim-ecash-button')).toBeNull()
            expect(screen.getByText(i18n.t('words.cancel'))).toBeOnTheScreen()
        })
    })

    // REGRESSION: a USDT note from a not-yet-joined federation (the invite
    // join-then-claim flow) must render its USDT amount, never "N SATS". The
    // display branches on `unit` alone, so `federation_type` never causes a
    // USDT note to be misrendered as sats.
    describe('when the note is a USDT note from a not-yet-joined federation', () => {
        beforeEach(() => {
            jest.spyOn(PayHooks, 'useParseEcash').mockImplementation(() => ({
                parseEcash: parseEcashSpy,
                loading: false,
                parsed: {
                    // 1,000,000 micros = 1 USDT. If this were misrendered as
                    // sats it would read "1,000 SATS" — the exact bug.
                    amount: 1_000_000 as MSats,
                    federation_invite: 'invite-code',
                    federation_type: 'notJoined',
                    unit: 'usdt',
                },
                ecashToken: '123',
                isError: false,
                federation: createMockFederationPreview(),
                newMembersDisabled: false,
            }))
        })

        it('renders the amount in USDT and never as SATS', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            expect(await screen.findByText(/USDT/)).toBeOnTheScreen()
            expect(screen.queryByText(/SATS/)).toBeNull()
        })
    })

    // REGRESSION: a note stamped with an unrecognized unit must show the
    // unsupported-asset notice and offer NO enabled claim button, rather than
    // rendering a (misleading) sats amount with a live claim action.
    describe('when the note is denominated in an unsupported unit', () => {
        beforeEach(() => {
            jest.spyOn(PayHooks, 'useParseEcash').mockImplementation(() => ({
                parseEcash: parseEcashSpy,
                loading: false,
                parsed: {
                    amount: 1_000_000 as MSats,
                    federation_id: '1',
                    federation_type: 'joined',
                    unit: 'other',
                },
                ecashToken: '123',
                isError: false,
                federation: mockFederation1 as LoadedFederation,
                newMembersDisabled: false,
            }))
        })

        it('shows the unsupported-asset notice and no claim button', async () => {
            renderWithProviders(
                <ClaimEcash
                    navigation={mockNavigation as any}
                    route={{ params: { id: '123' } } as any}
                />,
            )

            expect(
                await screen.findByText(
                    i18n.t('feature.ecash.unknown-asset-notice'),
                ),
            ).toBeOnTheScreen()
            expect(screen.queryByTestId('claim-ecash-button')).toBeNull()
            expect(screen.queryByText(/SATS/)).toBeNull()
        })
    })
})
