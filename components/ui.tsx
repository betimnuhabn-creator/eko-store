import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { colors, maxWidth, radius } from '../lib/theme';

export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
  style,
}: {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  if (!scroll) return <View style={[s.screen, s.inner, style]}>{children}</View>;
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.inner, style]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[s.card, style]} testID={testID}>
      {children}
    </View>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={s.h1}>{children}</Text>;
}
export function H2({ children }: { children: React.ReactNode }) {
  return <Text style={s.h2}>{children}</Text>;
}
export function Muted({ children, style }: { children: React.ReactNode; style?: any }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

type ButtonProps = {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Button({ title, onPress, variant = 'primary', icon, loading, disabled, small, style, testID }: ButtonProps) {
  const bg = { primary: colors.brand, secondary: colors.brandSoft, danger: colors.danger, ghost: 'transparent' }[variant];
  const fg = variant === 'primary' || variant === 'danger' ? '#fff' : colors.brand;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.button,
        small && s.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { paddingHorizontal: 4 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={small ? 16 : 18} color={fg} />}
          <Text style={[s.buttonText, small && { fontSize: 13 }, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  style,
  ...props
}: TextInputProps & { label?: string; error?: string | null }) {
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor="#94A3B8"
        autoCapitalize="none"
        accessibilityLabel={label ?? props.placeholder}
        {...props}
        style={[s.input, props.multiline && { minHeight: 80, textAlignVertical: 'top' }, error && { borderColor: colors.danger }, style]}
      />
      {error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}
    >
      <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={22} color={colors.brand} />
      <Text style={{ color: colors.text, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, testID }: { label: string; active?: boolean; onPress?: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: !!active }} onPress={onPress} style={[s.chip, active && { backgroundColor: colors.brand, borderColor: colors.brand }]}>
      <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, tone = 'info' }: { label: string; tone?: 'info' | 'success' | 'warning' | 'danger' | 'muted' }) {
  const map = {
    info: [colors.brandSoft, colors.brand],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    muted: ['#EEF2F6', colors.muted],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' | 'success' }) {
  const bg = { info: colors.brandSoft, warning: colors.warningSoft, success: colors.successSoft }[tone];
  const fg = { info: colors.brandDark, warning: colors.warning, success: colors.success }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius, padding: 12 }}>
      <Text style={{ color: fg, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

export function Empty({ text, icon = 'cube-outline' }: { text: string; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={{ alignItems: 'center', padding: 40, gap: 10 }}>
      <Ionicons name={icon} size={44} color="#A0AEC0" />
      <Text style={{ color: colors.muted, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function ListItem({
  title,
  subtitle,
  right,
  onPress,
  icon,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.listItem, pressed && onPress && { backgroundColor: '#F8FAFC' }]}>
      {icon && <Ionicons name={icon} size={22} color={colors.brand} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontWeight: '600', color: colors.text, fontSize: 15 }}>{title}</Text>
        {subtitle ? <Text style={{ color: colors.muted, fontSize: 13 }}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress && <Ionicons name="chevron-forward" size={18} color="#A0AEC0" />}
    </Pressable>
  );
}

export function QuantityStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <View style={s.stepper}>
      <Pressable accessibilityLabel="-" onPress={() => onChange(value - 1)} style={s.stepBtn}>
        <Ionicons name="remove" size={18} color={colors.brand} />
      </Pressable>
      <TextInput
        value={String(value)}
        onChangeText={(v) => onChange(parseInt(v.replace(/\D/g, '') || '0', 10))}
        keyboardType="number-pad"
        style={s.stepInput}
        accessibilityLabel="quantity"
      />
      <Pressable accessibilityLabel="+" onPress={() => onChange(value + 1)} style={s.stepBtn}>
        <Ionicons name="add" size={18} color={colors.brand} />
      </Pressable>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  inner: { padding: 16, gap: 12, paddingBottom: 40, width: '100%', maxWidth, alignSelf: 'center' },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: 14, gap: 8, borderWidth: 1, borderColor: '#E8EDF2' },
  h1: { fontSize: 22, fontWeight: '800', color: colors.text },
  h2: { fontSize: 17, fontWeight: '700', color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  label: { color: colors.text, fontWeight: '600', fontSize: 13 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.text,
  },
  button: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { fontWeight: '700', fontSize: 15 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#EEF2F6',
  },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: '#fff' },
  stepBtn: { padding: 9 },
  stepInput: { width: 54, textAlign: 'center', fontSize: 16, color: colors.text, paddingVertical: 6 },
});
