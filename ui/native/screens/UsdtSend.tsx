import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button } from '@rneui/themed'
import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet, View } from 'react-native'

import { AnyParsedData, ParserDataType } from '@fedi/common/types'

import {
    OmniInput,
    OmniInputAction,
} from '../components/feature/omni/OmniInput'
import { Column } from '../components/ui/Flex'
import SvgImage from '../components/ui/SvgImage'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtSend'>

type ExpectedInput = ParserDataType.EvmAddress | ParserDataType.FedimintEcash

/**
 * Scanner-first USDT send screen, mirroring the Bitcoin Send screen.
 *
 * Uses the shared omni parser/scanner: EVM addresses (`0x…` and
 * `ethereum:` URIs) resolve to a USDT recipient and route to the amount
 * step (a Fedi-convention `?amount=` param prefills the amount, which
 * stays editable), while scanned ecash tokens route to the claim flow.
 * Any other QR/paste is handled by `OmniInput` exactly as the global
 * scanner would (routed or shown the standard unsupported copy).
 */
const UsdtSend: React.FC<Props> = ({ navigation }) => {
    const { t } = useTranslation()

    const onExpectedInput = useCallback(
        (parsedData: Extract<AnyParsedData, { type: ExpectedInput }>) => {
            if (parsedData.type === ParserDataType.EvmAddress) {
                navigation.navigate('UsdtSendAmount', {
                    recipient: parsedData.data.address,
                    amountMicros: parsedData.data.amountMicros,
                })
                return
            }
            // FedimintEcash — route to the claim flow
            navigation.navigate('ClaimEcash', { id: parsedData.data.token })
        },
        [navigation],
    )

    const customActions: OmniInputAction[] = useMemo(
        () => [
            {
                label: (
                    <View style={style.buttonContainer}>
                        <Button
                            testID="SendEcashOfflineButton"
                            fullWidth
                            day
                            icon={<SvgImage name="Offline" />}
                            title={t('feature.usdt.send-ecash-offline')}
                            onPress={() =>
                                navigation.navigate('UsdtSendOfflineAmount')
                            }
                            containerStyle={style.buttonInnerContainerWMargin}
                        />
                    </View>
                ),
                onPress: () => undefined,
            },
        ],
        [navigation, t],
    )

    return (
        <Column grow fullWidth>
            <OmniInput
                expectedInputTypes={
                    [
                        ParserDataType.EvmAddress,
                        ParserDataType.FedimintEcash,
                    ] as const
                }
                onExpectedInput={onExpectedInput}
                onUnexpectedSuccess={() => null}
                customActions={customActions}
            />
        </Column>
    )
}

const style = StyleSheet.create({
    buttonContainer: {
        width: '100%',
        margin: 0,
        padding: 0,
    },
    buttonInnerContainerWMargin: {
        marginVertical: 6,
        padding: 0,
    },
})

export default UsdtSend
