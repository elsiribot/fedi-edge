import { Theme, useTheme } from '@rneui/themed'
import React from 'react'
import { StyleSheet, Vibration, useWindowDimensions } from 'react-native'
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSequence,
    withTiming,
} from 'react-native-reanimated'

import { NumpadButtonValue } from '@fedi/common/types/amount'
import { makeLog } from '@fedi/common/utils/log'

import { Row, Column } from './Flex'
import { NumpadButton } from './NumpadButton'

const log = makeLog('native/components/ui/NumpadFrame')

type Props = {
    /** Content rendered above the primary amount (e.g. a balance line) */
    preHeader?: React.ReactNode | null
    /** The primary amount entry, wrapped in the shared shake animation */
    primaryAmount: React.ReactNode
    /** Content rendered below the primary amount (switcher, error, notes, …) */
    belowPrimary?: React.ReactNode | null
    /** Whether the on-screen numpad grid is shown (tall enough & editable) */
    hasNumpad: boolean
    /** Ordered numpad key values to render */
    numpadButtons: readonly NumpadButtonValue[]
    /** Handle a key press; return true if the press was rejected (triggers shake) */
    onNumpadPress: (btn: NumpadButtonValue) => boolean
    /** Disables the numpad while a submission is in flight */
    isSubmitting?: boolean
}

/**
 * Shared frame for the Bitcoin (AmountInput) and USDT (UsdtAmountInput)
 * numpad amount entries. Owns the pieces that were duplicated verbatim
 * between them - the rejected-press shake animation, the numpad button
 * grid, and the outer layout/styles - while each input keeps its own
 * value model and key-handling semantics via `onNumpadPress` and the
 * `primaryAmount`/`belowPrimary` slots.
 */
export const NumpadFrame: React.FC<Props> = ({
    preHeader = null,
    primaryAmount,
    belowPrimary = null,
    hasNumpad,
    numpadButtons,
    onNumpadPress,
    isSubmitting,
}) => {
    const { theme } = useTheme()
    const { width } = useWindowDimensions()
    const style = styles(theme, width)

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
                    {primaryAmount}
                </Animated.View>
                {belowPrimary}
            </Column>
            {hasNumpad && (
                <Row wrap fullWidth style={style.numpad}>
                    {numpadButtons.map(btn => (
                        <NumpadButton
                            key={btn}
                            btn={btn}
                            onPress={() => {
                                try {
                                    const rejected = onNumpadPress(btn)
                                    if (rejected) onRejectedPress()
                                } catch (err) {
                                    log.error('onNumpadPress', err)
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
        numpad: {
            maxWidth: Math.min(400, width),
            paddingHorizontal: theme.spacing.lg,
        },
    })

export default NumpadFrame
