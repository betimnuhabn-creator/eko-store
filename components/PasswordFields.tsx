import React, { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { Checkbox, Field } from './ui';

/** New password + confirmation + show/hide, used by reset and change screens. */
export function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  onSubmit,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  onSubmit?: () => void;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Field
        label={t('newPassword')}
        placeholder={t('passwordHint')}
        value={password}
        onChangeText={onPassword}
        secureTextEntry={!visible}
        autoComplete="new-password"
        textContentType="newPassword"
        testID="pw-new"
      />
      <Field
        label={t('confirmPassword')}
        value={confirm}
        onChangeText={onConfirm}
        secureTextEntry={!visible}
        autoComplete="new-password"
        textContentType="newPassword"
        onSubmitEditing={onSubmit}
        testID="pw-confirm"
      />
      <Checkbox checked={visible} onChange={setVisible} label={t('showPassword')} />
    </>
  );
}
