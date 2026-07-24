import { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button, Text, useTheme } from '@rneui/themed'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { selectShouldRateFederation } from '@fedi/common/redux'

import RateFederationOverlay from '../components/feature/federations/RateFederationOverlay'
import { Column } from '../components/ui/Flex'
import SuccessShield from '../components/ui/SuccessShield'
import { useAppSelector } from '../state/hooks'
import { resetToWallets } from '../state/navigation'
import { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<
    RootStackParamList,
    'SendSuccessShield'
>

const SendSuccessShield: React.FC<Props> = ({ route, navigation }: Props) => {
    const { title, formattedAmount, description, nextScreenParams } =
        route.params

    const [showRateFederation, setShowRateFederation] = useState(false)
    const { t } = useTranslation()
    const shouldRateFederation = useAppSelector(s =>
        selectShouldRateFederation(s),
    )
    const { theme } = useTheme()

    // Some flows (e.g. USDT withdrawals) chain the success ceremony into a
    // follow-up status screen instead of landing back on the wallets tab
    const handleContinue = useCallback(() => {
        if (nextScreenParams) {
            navigation.replace(...nextScreenParams)
        } else {
            navigation.dispatch(resetToWallets())
        }
    }, [navigation, nextScreenParams])

    return (
        <>
            <SuccessShield
                message={
                    <Column center gap="md">
                        <Text h2 bolder center>
                            {title}
                        </Text>
                        {formattedAmount && (
                            <Text bolder center>
                                {formattedAmount}
                            </Text>
                        )}
                        {description && (
                            <Text color={theme.colors.darkGrey} center>
                                {description}
                            </Text>
                        )}
                    </Column>
                }
                button={
                    <Button
                        title={t('words.ok')}
                        onPress={() => {
                            if (shouldRateFederation) {
                                setShowRateFederation(true)
                            } else {
                                handleContinue()
                            }
                        }}
                    />
                }
            />
            {shouldRateFederation && (
                <RateFederationOverlay
                    show={showRateFederation}
                    onDismiss={() => {
                        setShowRateFederation(false)
                        if (nextScreenParams) {
                            navigation.replace(...nextScreenParams)
                        } else {
                            navigation.navigate('TabsNavigator', {
                                initialRouteName: 'Wallet',
                            })
                        }
                    }}
                />
            )}
        </>
    )
}

export default SendSuccessShield
