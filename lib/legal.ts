// Public legal pages (published with the PC panel on GitHub Pages).
import * as Linking from 'expo-linking';

const BASE = (process.env.EXPO_PUBLIC_LEGAL_BASE_URL || 'https://betimnuhabn-creator.github.io/eko-store/').replace(/\/?$/, '/');

export const PRIVACY_URL = `${BASE}privacy.html`;
export const TERMS_URL = `${BASE}terms.html`;
export const DELETE_ACCOUNT_URL = `${BASE}delete-account.html`;

export function openLegal(url: string) {
  Linking.openURL(url).catch(() => {});
}
