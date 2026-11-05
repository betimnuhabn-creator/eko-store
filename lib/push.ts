import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

let currentToken: string | null = null;

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Registers this phone for push notifications.
 * Needs a development/production build (not Expo Go) and an EAS project id
 * (run `eas init`), plus FCM credentials uploaded to EAS for Android.
 */
export async function registerForPush(): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
  if (!projectId) return;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'EKO Store',
        importance: Notifications.AndroidImportance.HIGH,
        lightColor: '#0166B4',
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    currentToken = token;
    await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS });
  } catch (e) {
    console.warn('push registration failed', e);
  }
}

export async function unregisterPush(): Promise<void> {
  if (!currentToken) return;
  await supabase.rpc('unregister_push_token', { p_token: currentToken }).then(() => {}, () => {});
  currentToken = null;
}

/** Calls `onOpen(url)` when the user taps a push notification. */
export function onPushOpened(onOpen: (url: string) => void): () => void {
  if (Platform.OS === 'web') return () => {};
  const handle = (r: Notifications.NotificationResponse | null) => {
    const url = r?.notification.request.content.data?.url;
    if (typeof url === 'string') onOpen(url);
  };
  Notifications.getLastNotificationResponseAsync().then(handle).catch(() => {});
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => sub.remove();
}

/** Browser (desktop) notifications for the web admin panel. */
export function browserNotify(title: string, body?: string) {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !('Notification' in window)) return;
  if (window.Notification.permission === 'granted') {
    try {
      new window.Notification(title, { body, icon: '/favicon.ico' });
    } catch {}
  }
}

export function browserNotificationsState(): 'unsupported' | NotificationPermission {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

export async function requestBrowserNotifications() {
  if (browserNotificationsState() === 'unsupported') return 'unsupported';
  return window.Notification.requestPermission();
}
