import React from 'react';
import { Pressable, Text } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';

export function LanguageToggle({ color = colors.brand }: { color?: string }) {
  const { lang, setLang } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="language"
      onPress={() => setLang(lang === 'sq' ? 'en' : 'sq')}
      style={{ paddingHorizontal: 10, paddingVertical: 6 }}
    >
      <Text style={{ color, fontWeight: '800' }}>{lang === 'sq' ? 'EN' : 'SQ'}</Text>
    </Pressable>
  );
}
