import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import type { Profile } from './types';

// Access rule: only a profile with role = 'admin' may use the panel.
// This check is for the UI. The real protection is the database: every admin
// function calls assert_admin() and RLS hides other customers' data.
const IDLE_LIMIT_MS = 30 * 60 * 1000;

type State = 'loading' | 'signed_out' | 'admin';
type Ctx = {
  state: State;
  session: Session | null;
  profile: Profile | null;
  notice: 'notAdmin' | 'sessionExpired' | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: (notice?: Ctx['notice']) => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

async function loadAdminProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data && (data as Profile).role === 'admin' ? (data as Profile) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notice, setNotice] = useState<Ctx['notice']>(null);
  const lastActivity = useRef(Date.now());

  const signOut = useCallback(async (n: Ctx['notice'] = null) => {
    await supabase.auth.signOut().catch(() => {});
    setSession(null);
    setProfile(null);
    setNotice(n);
    setState('signed_out');
  }, []);

  const verify = useCallback(
    async (s: Session | null) => {
      if (!s) {
        setSession(null);
        setProfile(null);
        setState('signed_out');
        return;
      }
      const p = await loadAdminProfile(s.user.id).catch(() => null);
      if (!p) return signOut('notAdmin');
      setSession(s);
      setProfile(p);
      setNotice(null);
      setState('admin');
    },
    [signOut],
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => verify(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') {
        setSession(null);
        setProfile(null);
        setState('signed_out');
      } else if (event === 'TOKEN_REFRESHED' && s) {
        setSession(s);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [verify]);

  // Inactivity logout + re-check of the admin role when the tab gets focus.
  useEffect(() => {
    if (state !== 'admin') return;
    const touch = () => (lastActivity.current = Date.now());
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_LIMIT_MS) signOut('sessionExpired');
    }, 30_000);
    const onFocus = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session || !(await loadAdminProfile(data.session.user.id).catch(() => null))) signOut('notAdmin');
    };
    window.addEventListener('focus', onFocus);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [state, signOut]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      session,
      profile,
      notice,
      signOut,
      signIn: async (email, password) => {
        setNotice(null);
        const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) return error.message;
        lastActivity.current = Date.now();
        await verify(data.session);
        return null;
      },
    }),
    [state, session, profile, notice, signOut, verify],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
