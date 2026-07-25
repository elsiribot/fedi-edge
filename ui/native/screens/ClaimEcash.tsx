import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, Theme, useTheme } from '@rneui/themed'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Linking, StyleSheet } from 'react-native'
import Hyperlink from 'react-native-hyperlink'

import { useParseEcash, useClaimEcash } from '@fedi/common/hooks/pay'
import { useToast } from '@fedi/common/hooks/toast'
import { useFormatUsdtMicros } from '@fedi/common/hooks/usdt'
import { RpcEcashInfo } from '@fedi/common/types/bindings'
import amountUtils from '@fedi/common/utils/AmountUtils'
import { getFederationTosUrl } from '@fedi/common/utils/FederationUtils'

import { FederationLogo } from '../components/feature/federations/FederationLogo'
import { Row, Column } from '../components/ui/Flex'
import HoloLoader from '../components/ui/HoloLoader'
import { SafeScrollArea } from '../components/ui/SafeArea'
import SvgImage from '../components/ui/SvgImage'
import { navigateToHome, resetToWallets } from '../state/navigation'
import { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<RootStackParamList, 'ClaimEcash'>

const ClaimEcash: React.FC<Props> = ({ navigation, route }) => {
    const { id } = route.params ?? {}

    const { theme } = useTheme()
    const { t } = useTranslation()
    const toast = useToast()
    const formatUsdt = useFormatUsdtMicros()

    const [tosUrl, setTosUrl] = useState<string | null>(null)

    const {
        parseEcash,
        loading: validating,
        parsed: parsedEcash,
        ecashToken,
        federation,
        newMembersDisabled,
    } = useParseEcash()

    const {
        claimEcash,
        loading: claiming,
        claimed: ecashClaimed,
        isError: isClaimError,
    } = useClaimEcash()

    // Validate ecash token on load
    useEffect(() => {
        if (!id) return

        parseEcash(id)
    }, [id, parseEcash])

    useEffect(() => {
        if (!federation?.meta) return

        setTosUrl(getFederationTosUrl(federation.meta))
    }, [federation])

    useEffect(() => {
        if (isClaimError) {
            toast.error(t, 'feature.ecash.claim-ecash-error')
        }
    }, [isClaimError, t, toast])

    let content: React.ReactElement | null = null
    let actions: React.ReactElement | null = null

    // Renders the ecash amount according to the unit stamped on the note,
    // branching on `unit` alone (NOT `federation_type`): a joined-vs-notJoined
    // USDT note is still USDT. `usdt` renders as USDT; `other`/unrecognized is
    // an asset we can't safely denominate, so we render the bare amount, flag
    // `unknownUnit` (the caller shows an unsupported-asset notice and disables
    // the claim button), and never render it as SATS. `bitcoin` or `null`
    // (legacy v1/unitless notes, which are genuinely Bitcoin) render as SATS.
    const getEcashAmountDisplay = (info: RpcEcashInfo) => {
        if (info.unit === 'usdt') {
            return { label: formatUsdt(info.amount), unknownUnit: false }
        }
        if (info.unit === 'other') {
            return { label: `${info.amount}`, unknownUnit: true }
        }
        return {
            label: `${amountUtils.msatToSatString(info.amount)} SATS`,
            unknownUnit: false,
        }
    }

    const style = styles(theme)

    if (validating) {
        content = (
            <Column center grow>
                <HoloLoader size={60} />
            </Column>
        )
    } else if (!parsedEcash) {
        content = (
            <>
                <SvgImage name="AlertWarningTriangle" size={48} />
                <Text h2>{t('feature.ecash.invalid-ecash-token')}</Text>
                <Text center>
                    {t('feature.ecash.invalid-ecash-token-description')}
                </Text>
            </>
        )
        actions = (
            <Button
                fullWidth
                loading={claiming}
                disabled={claiming}
                onPress={() => navigation.dispatch(navigateToHome())}>
                {t('words.cancel')}
            </Button>
        )
    } else if (ecashClaimed) {
        content = (
            <>
                <SvgImage name="Check" size={48} />
                <Text h2>{t('feature.ecash.ecash-claimed')}</Text>
                <Text center>
                    {t('feature.ecash.claim-ecash-success-description')}
                </Text>
            </>
        )
        actions = (
            <>
                <Button
                    fullWidth
                    onPress={() => navigation.dispatch(resetToWallets())}>
                    {t('feature.ecash.go-to-wallet')}
                </Button>
                <Button
                    fullWidth
                    type="clear"
                    onPress={() => navigation.dispatch(navigateToHome())}>
                    {t('phrases.maybe-later')}
                </Button>
            </>
        )
    } else if (newMembersDisabled) {
        const { label, unknownUnit } = getEcashAmountDisplay(parsedEcash)
        content = (
            <>
                <SvgImage name="AlertWarningTriangle" size={48} />
                <Text h2>{label}</Text>
                {unknownUnit && (
                    <Text center style={style.wrapperTextDesc}>
                        {t('feature.ecash.unknown-asset-notice')}
                    </Text>
                )}
                <Text center>
                    {t('feature.ecash.claim-ecash-new-members-disabled')}
                </Text>
            </>
        )
        actions = (
            <Button
                fullWidth
                onPress={() => navigation.dispatch(navigateToHome())}>
                {t('words.cancel')}
            </Button>
        )
    } else {
        const { label, unknownUnit } = getEcashAmountDisplay(parsedEcash)
        content = (
            <>
                <SvgImage name="Cash" size={48} />
                <Text h2>{label}</Text>
                {unknownUnit && (
                    <Text center style={style.wrapperTextDesc}>
                        {t('feature.ecash.unknown-asset-notice')}
                    </Text>
                )}
                <Text center>{t('feature.ecash.claim-ecash-description')}</Text>
            </>
        )

        actions = (
            <>
                {federation && (
                    <Column gap="md" style={{ marginBottom: theme.spacing.lg }}>
                        <Row style={style.federationWrapper} gap="md">
                            <FederationLogo federation={federation} size={32} />
                            <Column style={style.wrapperText} justify="center">
                                {parsedEcash?.federation_type ===
                                'notJoined' ? (
                                    <Text small style={style.wrapperTextDesc}>
                                        {t(
                                            'feature.ecash.adding-to-new-wallet',
                                            {
                                                federation_name:
                                                    federation.name,
                                            },
                                        )}
                                    </Text>
                                ) : (
                                    <Text small style={style.wrapperTextDesc}>
                                        {t(
                                            'feature.ecash.adding-to-existing-wallet',
                                            {
                                                federation_name:
                                                    federation.name,
                                            },
                                        )}
                                    </Text>
                                )}
                            </Column>
                        </Row>

                        {parsedEcash?.federation_type === 'notJoined' &&
                            tosUrl && (
                                <Hyperlink
                                    onPress={() => Linking.openURL(tosUrl)}
                                    linkStyle={style.linkText}>
                                    <Text small style={style.wrapperTextDesc}>
                                        {t('feature.ecash.terms-link', {
                                            tos_url: tosUrl,
                                        })}
                                    </Text>
                                </Hyperlink>
                            )}
                    </Column>
                )}

                {!unknownUnit && (
                    <Button
                        testID="claim-ecash-button"
                        fullWidth
                        loading={claiming}
                        disabled={claiming}
                        onPress={() => claimEcash(parsedEcash, ecashToken)}>
                        {t('feature.ecash.claim-ecash')}
                    </Button>
                )}
                <Button
                    fullWidth
                    type="clear"
                    onPress={() => navigation.dispatch(navigateToHome())}>
                    {t('phrases.maybe-later')}
                </Button>
            </>
        )
    }

    return (
        <SafeScrollArea edges="notop">
            <Column grow center gap={theme.spacing.sm}>
                {content}
            </Column>
            <Column fullWidth>{actions}</Column>
        </SafeScrollArea>
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        federationWrapper: {
            backgroundColor: theme.colors.offWhite100,
            borderRadius: 8,
            padding: theme.spacing.sm,
        },
        wrapperText: {
            flex: 1,
        },
        wrapperTextDesc: {
            color: theme.colors.darkGrey,
        },
        linkText: { color: theme.colors.link },
    })

export default ClaimEcash
