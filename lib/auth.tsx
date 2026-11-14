import type { Session } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { unregisterPush } from './push';
import { supabase } from './supabase';
import type { Profile } from './types';

type Ctx = {
  ready: boolean;
  session: Session | null;
  profile: Profile | null;
  isAdmin: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      return;
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
    setProfile((data as Profile) ?? null);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadProfile(data.session).catch(() => {});
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer: Supabase recommends not awaiting other calls inside this callback.
        setTimeout(() => loadProfile(s).catch(() => {}), 0);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<Ctx>(
    () => ({
      ready,
      session,
      profile,
      isAdmin: profile?.role === 'admin',
      refreshProfile: () => loadProfile(session),
      signOut: async () => {
        await unregisterPush();
        await supabase.auth.signOut().catch(() => {});
        setProfile(null);
      },
    }),
    [ready, session, profile, loadProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
