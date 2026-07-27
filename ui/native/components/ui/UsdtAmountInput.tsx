import { Text, Theme, useTheme } from '@rneui/themed'
import React, { useRef } from 'react'
import {
    Pressable,
    StyleSheet,
    TextInput,
    useWindowDimensions,
} from 'react-native'

import { useUsdtDecimalSeparator } from '@fedi/common/hooks/usdt'
import { NumpadButtonValue, numpadButtons } from '@fedi/common/types/amount'
import { USDT_ENTRY_MAX_DECIMALS } from '@fedi/common/utils/usdt'

import { useForceBlurOnKeyboardHide } from '../../utils/hooks/keyboard'
import { Column } from './Flex'
import InvisibleInput from './InvisibleInput'
import { NumpadFrame } from './NumpadFrame'

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
    const { height } = useWindowDimensions()

    // For some reason the TextInput inside InvisibleInput does not
    // automatically blur the input when the keyboard is dismissed
    // which causes the .focus() event to have no effect so here we
    // force the blur to make sure .isFocused() returns false
    useForceBlurOnKeyboardHide(true)

    const style = styles(theme)

    // Locale-aware decimal separator ('.' for en-US, ',' for de-DE, …).
    // `amountInput` is always kept in this separator - callers must pass
    // the same separator to `parseUsdtInput` when parsing it.
    const decimalSeparator = useUsdtDecimalSeparator()

    // Fallback for small screens where the numpad is hidden and the OS
    // keyboard is used instead: keep only digits and one decimal
    // separator, clamped to the supported precision (UI entry policy:
    // cents, i.e. `USDT_ENTRY_MAX_DECIMALS`). Hardware/soft keyboards may
    // emit either '.' or ',' regardless of locale, so both are normalized
    // to the active locale separator (mirrors useAmountInput's numpad
    // handling).
    const handleChangeText = (value: string) => {
        const cleaned = value
            .replace(/[.,]/g, decimalSeparator)
            .replace(new RegExp(`[^0-9${decimalSeparator}]`, 'g'), '')
        const firstSep = cleaned.indexOf(decimalSeparator)
        const whole = (
            firstSep === -1 ? cleaned : cleaned.slice(0, firstSep)
        ).slice(0, MAX_WHOLE_DIGITS)
        if (firstSep === -1) {
            onChangeAmountInput(whole)
            return
        }
        const fraction = cleaned
            .slice(firstSep + 1)
            .split(decimalSeparator)
            .join('')
            .slice(0, USDT_ENTRY_MAX_DECIMALS)
        onChangeAmountInput(`${whole}${decimalSeparator}${fraction}`)
    }

    /** Returns true if the press was rejected (triggers the shake) */
    const handleNumpadPress = (btn: NumpadButtonValue): boolean => {
        if (btn === 'backspace') {
            onChangeAmountInput(amountInput.slice(0, -1))
            return false
        }
        // The numpad's decimal key always raises the raw '.' button value
        // regardless of locale - translate it to the locale separator
        if (btn === '.') {
            if (amountInput.includes(decimalSeparator)) return true
            onChangeAmountInput(
                amountInput
                    ? `${amountInput}${decimalSeparator}`
                    : `0${decimalSeparator}`,
            )
            return false
        }
        const next =
            amountInput === '0' ? String(btn) : amountInput + String(btn)
        const [whole = '', fraction = ''] = next.split(decimalSeparator)
        // Ignore a 3rd decimal digit - UI entry is capped at cents
        if (fraction.length > USDT_ENTRY_MAX_DECIMALS) return true
        if (whole.length > MAX_WHOLE_DIGITS) return true
        onChangeAmountInput(next)
        return false
    }

    const hasNumpad = height >= 500 && !readOnly

    return (
        <NumpadFrame
            hasNumpad={hasNumpad}
            numpadButtons={numpadButtons}
            onNumpadPress={handleNumpadPress}
            isSubmitting={isSubmitting}
            preHeader={preHeader}
            primaryAmount={
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
            }
            belowPrimary={
                <>
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
                </>
            }
        />
    )
}

const styles = (theme: Theme) =>
    StyleSheet.create({
        primaryAmount: {
            flexDirection: 'row',
            alignItems: 'flex-end',
            marginHorizontal: theme.spacing.lg,
            width: '100%',
        },
        error: {
            color: theme.colors.red,
        },
        errorContainer: {
            minHeight: theme.sizes.sm,
        },
    })

export default UsdtAmountInput
