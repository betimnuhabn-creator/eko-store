import React from 'react';
import { Text } from 'react-native';
import { useI18n } from '../lib/i18n';
import { PRIVACY_URL, TERMS_URL, openLegal } from '../lib/legal';
import { colors } from '../lib/theme';

/** "Duke u regjistruar pranoni Kushtet e përdorimit dhe Politikën e privatësisë." */
export function RegisterConsent() {
  const { t } = useI18n();
  const link = (label: string, url: string, id: string) => (
    <Text style={{ color: colors.brand, fontWeight: '600' }} onPress={() => openLegal(url)} accessibilityRole="link" testID={id}>
      {label}
    </Text>
  );
  return (
    <Text style={{ color: colors.muted, fontSize: 13, textAlign: 'center' }}>
      {t('consentPrefix')} {link(t('termsOfService'), TERMS_URL, 'link-terms')} {t('consentAnd')} {link(t('privacyPolicy'), PRIVACY_URL, 'link-privacy')}.
    </Text>
  );
}
