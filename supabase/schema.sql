-- =====================================================================
-- Factures BO : base de données, sécurité et stockage des justificatifs
-- À coller en entier dans Supabase > SQL Editor > New query, puis "Run".
-- Le script peut être relancé sans risque.
-- =====================================================================

-- 1. Liste des personnes autorisées (les 2 associés).
--    Seules ces adresses e-mail peuvent voir et modifier les données.
create table if not exists public.members (
  email text primary key
);
alter table public.members enable row level security;  -- illisible depuis l'app

-- >>> REMPLACEZ les deux adresses ci-dessous par les vôtres, puis lancez le script.
insert into public.members (email) values
  ('associe1@exemple.fr'),
  ('associe2@exemple.fr')
on conflict do nothing;

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_member() to authenticated;

-- 2. Factures et tickets
create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  supplier      text not null default '',
  date          date,
  ttc           numeric(12,2) not null,
  tva           numeric(12,2),
  ht            numeric(12,2),
  category      text not null default '',
  description   text not null default '',
  payer         text not null default '',        -- id de l'associé, ou 'societe'
  method        text not null default 'cb_pro',  -- cb_pro, virement, prelevement, cheque, especes_pro, cb_perso, especes_perso, virement_perso
  paid          boolean not null default true,
  due_date      date,
  number        text not null default '',
  notes         text not null default '',
  reimb_status  text check (reimb_status in ('du','rembourse')),
  reimb_date    date,
  file_path     text,
  file_type     text check (file_type in ('image','pdf')),
  file_name     text,
  thumb_path    text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  updated_at    timestamptz not null default now()
);
create index if not exists invoices_date_idx on public.invoices (date desc);
alter table public.invoices enable row level security;

drop policy if exists "membres: lecture"      on public.invoices;
drop policy if exists "membres: ajout"        on public.invoices;
drop policy if exists "membres: modification" on public.invoices;
drop policy if exists "membres: suppression"  on public.invoices;
create policy "membres: lecture"      on public.invoices for select to authenticated using (public.is_member());
create policy "membres: ajout"        on public.invoices for insert to authenticated with check (public.is_member());
create policy "membres: modification" on public.invoices for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "membres: suppression"  on public.invoices for delete to authenticated using (public.is_member());

-- 3. Réglages partagés (noms des associés, cartes, catégories) : une seule ligne
create table if not exists public.settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "membres: réglages" on public.settings;
create policy "membres: réglages" on public.settings for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- 4. Mises à jour en direct entre les deux téléphones
do $$
begin
  begin alter publication supabase_realtime add table public.invoices; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings; exception when duplicate_object then null; end;
end $$;

-- 5. Stockage privé des photos et PDF (20 Mo max par fichier)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificatifs', 'justificatifs', false, 20971520,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "membres: lire justificatifs"      on storage.objects;
drop policy if exists "membres: ajouter justificatifs"   on storage.objects;
drop policy if exists "membres: modifier justificatifs"  on storage.objects;
drop policy if exists "membres: supprimer justificatifs" on storage.objects;
create policy "membres: lire justificatifs"      on storage.objects for select to authenticated using (bucket_id = 'justificatifs' and public.is_member());
create policy "membres: ajouter justificatifs"   on storage.objects for insert to authenticated with check (bucket_id = 'justificatifs' and public.is_member());
create policy "membres: modifier justificatifs"  on storage.objects for update to authenticated using (bucket_id = 'justificatifs' and public.is_member());
create policy "membres: supprimer justificatifs" on storage.objects for delete to authenticated using (bucket_id = 'justificatifs' and public.is_member());
