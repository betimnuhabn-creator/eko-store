import { router } from 'expo-router';

/** Go back, or to `fallback` when there is no history (e.g. a page opened directly on the web). */
export function goBack(fallback: string = '/') {
  if (router.canGoBack()) router.back();
  else router.replace(fallback as any);
}
