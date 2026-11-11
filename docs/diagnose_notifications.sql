-- EKO Store — notification diagnosis (READ ONLY: changes nothing, sends nothing).
-- Supabase → SQL Editor → New query → paste everything → Run.
select section, detail from (
  -- 1. Settings
  select 1 as ord, now() as t, '1 settings' as section,
         format('enabled=%s test_only=%s daily_cap=%s wait_minutes=%s functions_url=%s dispatch=%s',
                enabled, test_only, daily_cap, debounce_minutes,
                case when functions_url = '' then '(empty)' else functions_url end,
                public.promo_dispatch_status()) as detail
    from public.promo_settings where id
  union all
  -- 2. Each promo tester: preferences, phones, promo notifications in the last 24 h (daily cap)
  select 2, now(), '2 tester',
         format('%s | role=%s wholesale=%s | prefs: offers=%s new_products=%s price_changes=%s | phones=%s (last %s) | promo last 24h=%s of cap %s%s',
                p.email, p.role, p.wholesale_status, p.promo_offers, p.promo_new_products, p.promo_price_changes,
                (select count(*) from public.push_tokens t where t.user_id = p.id),
                coalesce((select to_char(max(t.updated_at) at time zone 'Europe/Belgrade', 'DD.MM HH24:MI') from public.push_tokens t where t.user_id = p.id), '-'),
                c.n, s.daily_cap,
                case when c.n >= s.daily_cap
                     then format(' → CAP REACHED: no promo notification until %s',
                                 to_char((c.oldest + interval '24 hours') at time zone 'Europe/Belgrade', 'DD.MM HH24:MI'))
                     else '' end)
    from public.profiles p
    cross join public.promo_settings s
    cross join lateral (select count(*) n, min(created_at) oldest from public.notifications nn
                         where nn.recipient_id = p.id and nn.category = 'promo'
                           and nn.created_at > now() - interval '24 hours') c
   where p.promo_tester and s.id
  union all
  -- 3. Last promotional events
  select 3, e.created_at, '3 promo event',
         format('%s | %s | %s | recipients=%s%s', to_char(e.created_at at time zone 'Europe/Belgrade', 'DD.MM HH24:MI'),
                e.kind, e.status, coalesce(e.recipients::text, '-'), coalesce(' | error: ' || e.error, ''))
    from (select * from public.promo_events order by created_at desc limit 8) e
  union all
  -- 4. Last notifications of the testers (in-app list + push delivery)
  select 4, n.created_at, '4 tester notification',
         format('%s | %s | %s | push: %s | attempts=%s%s', to_char(n.created_at at time zone 'Europe/Belgrade', 'DD.MM HH24:MI'),
                n.type, n.category,
                case when n.dispatched_at is not null then 'sent ' || to_char(n.dispatched_at at time zone 'Europe/Belgrade', 'HH24:MI') else 'WAITING' end,
                n.attempts, coalesce(' | error: ' || n.last_error, ''))
    from (select nn.* from public.notifications nn join public.profiles p on p.id = nn.recipient_id
           where p.promo_tester order by nn.created_at desc limit 10) n
  union all
  -- 5. Scheduler: last runs
  select 5, d.start_time, '5 scheduler',
         format('%s | %s | %s | %s', j.jobname, to_char(d.start_time at time zone 'Europe/Belgrade', 'DD.MM HH24:MI'), d.status, left(d.return_message, 120))
    from cron.job j
    join lateral (select * from cron.job_run_details r where r.jobid = j.jobid order by start_time desc limit 2) d on true
   where j.jobname like 'eko-%'
) x
order by ord, t desc;
