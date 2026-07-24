import { Text, Theme, useTheme } from '@rneui/themed'
import React, { useRef } from 'react'
import {
    Pressable,
    StyleSheet,
    TextInput,
    Vibration,
    useWindowDimensions,
} from 'react-native'
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSequence,
    withTiming,
} from 'react-native-reanimated'

import { NumpadButtonValue, numpadButtons } from '@fedi/common/types/amount'
import { makeLog } from '@fedi/common/utils/log'
import { USDT_DECIMALS } from '@fedi/common/utils/usdt'

import { useForceBlurOnKeyboardHide } from '../../utils/hooks/keyboard'
import { Row, Column } from './Flex'
import InvisibleInput from './InvisibleInput'
import { NumpadButton } from './NumpadButton'

const log = makeLog('native/components/ui/UsdtAmountInput')

// Caps the whole part at 999,999,999 USDT so amounts always stay well
// within Number.isSafeInteger when converted to micros
const MAX_WHOLE_DIGITS = 9

export type Props = {
    /** Raw decimal USDT amount string, e.g. "1.5" (empty for no amount) */
    amountInput: string
    onChangeAmountInput: (value: string) => void
    readOnly?: boolean
    isSubmitting?: boolean
    error?: string | null
    content?: React.ReactNode | null
    preHeader?: React.ReactNode | null
}

/**
 * USDT variant of the numpad amount entry used by the Bitcoin flows
 * (AmountInput). Built on the same primitives (InvisibleInput +
 * NumpadButton) so the keypad look/feel matches exactly, but denominated
 * purely in USDT (2..6 decimal places) with no sats/fiat conversion row.
 */
const UsdtAmountInput: React.FC<Props> = ({
    amountInput,
    onChangeAmountInput,
    readOnly,
    isSubmitting,
    error,
    content = null,
    preHeader = null,
}) => {
    const { theme } = useTheme()
    const inputRef = useRef<TextInput>(null)
    const { height, width } = useWindowDimensions()

    // For some reason the TextInput inside InvisibleInput does not
    // automatically blur the input when the keyboard is dismissed
    // which causes the .focus() event to have no effect so here we
    // force the blur to make sure .isFocused() returns false
    useForceBlurOnKeyboardHide(true)

    const style = styles(theme, width)

    // Fallback for small screens where the numpad is hidden and the OS
    // keyboard is used instead: keep only digits and one decimal point,
    // clamped to the supported precision
    const handleChangeText = (value: string) => {
        const cleaned = value.replace(/,/g, '.').replace(/[^0-9.]/g, '')
        const firstDot = cleaned.indexOf('.')
        const whole = (
            firstDot === -1 ? cleaned : cleaned.slice(0, firstDot)
        ).slice(0, MAX_WHOLE_DIGITS)
        if (firstDot === -1) {
            onChangeAmountInput(whole)
            return
        }
        const fraction = cleaned
            .slice(firstDot + 1)
            .replace(/\./g, '')
            .slice(0, USDT_DECIMALS)
        onChangeAmountInput(`${whole}.${fraction}`)
    }

    /** Returns true if the press was rejected (triggers the shake) */
    const handleNumpadPress = (btn: NumpadButtonValue): boolean => {
        if (btn === 'backspace') {
            onChangeAmountInput(amountInput.slice(0, -1))
            return false
        }
        if (btn === '.') {
            if (amountInput.includes('.')) return true
            onChangeAmountInput(amountInput ? `${amountInput}.` : '0.')
            return false
        }
        const next =
            amountInput === '0' ? String(btn) : amountInput + String(btn)
        const [whole = '', fraction = ''] = next.split('.')
        if (fraction.length > USDT_DECIMALS) return true
        if (whole.length > MAX_WHOLE_DIGITS) return true
        onChangeAmountInput(next)
        return false
    }

    const hasNumpad = height >= 500 && !readOnly

    const shake = useSharedValue(0)
    const onRejectedPress = () => {
        Vibration.vibrate(40)
        shake.value = withSequence(
            withTiming(8, { duration: 50 }),
            withTiming(-8, { duration: 50 }),
            withTiming(0, { duration: 50 }),
        )
    }
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: shake.value }],
    }))

    return (
        <Column grow align="center" fullWidth>
            <Column center gap="sm" grow style={style.amounts}>
                <Column fullWidth>{preHeader}</Column>
                <Animated.View style={animatedStyle}>
                    <Pressable
                        style={style.primaryAmount}
                        disabled={readOnly || hasNumpad || isSubmitting}
                        onPress={() => inputRef?.current?.focus()}>
                        <InvisibleInput
                            inputRef={inputRef}
                            value={amountInput || '0'}
                            label="USDT"
                            onChangeText={handleChangeText}
                            readOnly={readOnly || hasNumpad || isSubmitting}
                        />
                    </Pressable>
                </Animated.View>
                <Column center fullWidth style={style.errorContainer}>
                    {error && (
                        <Text
                            style={style.error}
                            caption
                            testID="amount-input-error">
                            {error}
                        </Text>
                    )}
                </Column>
                {content && <Column fullWidth>{content}</Column>}
            </Column>
            {hasNumpad && (
                <Row wrap fullWidth style={style.numpad}>
                    {numpadButtons.map(btn => (
                        <NumpadButton
                            key={btn}
                            btn={btn}
                            onPress={() => {
                                try {
                                    const rejected = handleNumpadPress(btn)
                                    if (rejected) onRejectedPress()
                                } catch (err) {
                                    log.error('handleNumpadPress', err)
                                }
                            }}
                            disabled={isSubmitting}
                        />
                    ))}
                </Row>
            )}
        </Column>
    )
}

const styles = (theme: Theme, width: number) =>
    StyleSheet.create({
        amounts: {
            paddingHorizontal: theme.spacing.lg,
        },
        primaryAmount: {
            flexDirection: 'row',
            alignItems: 'flex-end',
            marginHorizontal: theme.spacing.lg,
            width: '100%',
        },
        error: {
            color: theme.colors.red,
        },
        numpad: {
            maxWidth: Math.min(400, width),
            paddingHorizontal: theme.spacing.lg,
        },
        errorContainer: {
            minHeight: theme.sizes.sm,
        },
    })

export default UsdtAmountInput
