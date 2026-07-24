import Clipboard from '@react-native-clipboard/clipboard'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Button } from '@rneui/themed'
import React, { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { StyleSheet, View } from 'react-native'

import { useToast } from '@fedi/common/hooks/toast'
import { parseUsdtRecipientInput } from '@fedi/common/utils/usdt'

import { OmniInputAction } from '../components/feature/omni/OmniInput'
import { OmniQrScanner } from '../components/feature/omni/OmniQrScanner'
import { Column } from '../components/ui/Flex'
import SvgImage from '../components/ui/SvgImage'
import type { RootStackParamList } from '../types/navigation'

export type Props = NativeStackScreenProps<RootStackParamList, 'UsdtSend'>

/**
 * Scanner-first USDT send screen, mirroring the Bitcoin Send screen.
 *
 * The omni parser doesn't understand EVM addresses, so scanned/pasted
 * input is parsed locally via `parseUsdtRecipientInput`. Raw `0x…`
 * addresses and `ethereum:0x…` URIs are accepted; any EIP-681 amount
 * params (`value`/`uint256`) are ignored — the amount is always entered
 * on the next screen.
 */
const UsdtSend: React.FC<Props> = ({ navigation }) => {
    const { t } = useTranslation()
    const toast = useToast()
    // Pause scanning while the amount step (or another screen) is on top
    const isFocused = useIsFocused()

    // Avoid spamming toasts while an invalid QR code stays in view
    const lastInvalidInputRef = useRef<string | null>(null)

    const handleInput = useCallback(
        (data: string) => {
            const recipient = parseUsdtRecipientInput(data)
            if (recipient) {
                lastInvalidInputRef.current = null
                navigation.navigate('UsdtSendAmount', { recipient })
            } else if (lastInvalidInputRef.current !== data) {
                lastInvalidInputRef.current = data
                toast.show({
                    content: t('feature.usdt.invalid-address'),
                    status: 'error',
                })
            }
        },
        [navigation, t, toast],
    )

    const handlePaste = useCallback(async () => {
        try {
            const content = await Clipboard.getString()
            if (!content || content.trim() === '') {
                toast.show({
                    content: t('feature.omni.error-paste-empty'),
                    status: 'error',
                })
                return
            }
            // Always surface feedback for explicit paste actions
            lastInvalidInputRef.current = null
            handleInput(content)
        } catch (err) {
            toast.error(t, err)
        }
    }, [handleInput, t, toast])

    const actions: OmniInputAction[] = useMemo(
        () => [
            {
                label: (
                    <View style={style.buttonContainer}>
                        <Button
                            testID="PasteButton"
                            fullWidth
                            day
                            icon={<SvgImage name="Clipboard" />}
                            title={t('feature.omni.action-paste')}
                            onPress={handlePaste}
                            containerStyle={style.buttonInnerContainer}
                        />
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
        [handlePaste, navigation, t],
    )

    return (
        <Column grow fullWidth>
            <OmniQrScanner
                onInput={handleInput}
                actions={actions}
                isProcessing={!isFocused}
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
    buttonInnerContainer: {
        marginVertical: 0,
        padding: 0,
    },
    buttonInnerContainerWMargin: {
        marginVertical: 6,
        padding: 0,
    },
})

export default UsdtSend
