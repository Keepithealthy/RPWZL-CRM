-- CRM-entered data (DATA_MODEL 5) and validation tables (DATA_MODEL 4). Writer: user RPCs (and import RPCs for proposals).

create table crm.lead (
  entry_id        int primary key references crm.reg_entry (id),
  status_id       smallint not null references crm.lead_status (id),
  owner_id        smallint references crm.team_member (id),
  tags            smallint[] not null default '{}',
  short_name      text check (length(short_name) <= 200),
  dnc             boolean not null default false,
  dnc_reason      text check (length(dnc_reason) <= 1000),
  dnc_at          timestamptz,
  dnc_by          smallint,
  validation      smallint check (validation between 0 and 3),
  validation_note text check (length(validation_note) <= 2000),
  checklist       jsonb,
  validated_at    timestamptz,
  validated_by    smallint,
  next_step_at    date,
  next_step_note  text check (length(next_step_note) <= 500),
  last_contact_at timestamptz,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      smallint
);
create index lead_owner_idx on crm.lead (owner_id);
create index lead_status_idx on crm.lead (status_id);
create index lead_next_step on crm.lead (next_step_at) where next_step_at is not null;
create index lead_tags on crm.lead using gin (tags);

create table crm.lead_contact (
  id          int generated always as identity primary key,
  entry_id    int not null references crm.reg_entry (id),
  kind        text not null check (kind in ('email', 'phone', 'www', 'person')),
  value       text check (length(value) <= 500),
  value_norm  text,
  person_name text check (length(person_name) <= 200),
  person_role text check (length(person_role) <= 200),
  status      text not null default 'unknown' check (status in ('ok', 'invalid', 'unknown')),
  is_primary  boolean not null default false,
  source      text not null default 'crm' check (source in ('crm', 'register')),
  note        text check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  smallint
);
create index lead_contact_entry on crm.lead_contact (entry_id);
create unique index lead_contact_one_primary on crm.lead_contact (entry_id, kind) where is_primary;

create table crm.activity (
  id            bigint generated always as identity primary key,
  entry_id      int not null references crm.reg_entry (id),
  type          text not null check (type in ('call', 'sms', 'email', 'meeting', 'note', 'status', 'owner', 'validation', 'dnc', 'task')),
  outcome       text,
  contact_value text,
  subject       text check (length(subject) <= 500),
  body          text check (length(body) <= 5000),
  status_from   smallint,
  status_to     smallint,
  template_id   int,
  task_id       bigint,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  created_by    smallint not null references crm.team_member (id),
  updated_at    timestamptz
);
create index activity_entry on crm.activity (entry_id, occurred_at desc);
create index activity_by on crm.activity (created_by, occurred_at desc);

create table crm.task (
  id          bigint generated always as identity primary key,
  entry_id    int references crm.reg_entry (id),
  title       text not null check (length(btrim(title)) > 0 and length(title) <= 300),
  note        text check (length(note) <= 2000),
  due_date    date not null,
  due_time    time,
  assignee_id smallint not null references crm.team_member (id),
  done_at     timestamptz,
  done_by     smallint,
  created_at  timestamptz not null default now(),
  created_by  smallint,
  updated_at  timestamptz not null default now(),
  updated_by  smallint
);
create index task_open on crm.task (assignee_id, due_date) where done_at is null;
create index task_entry on crm.task (entry_id);

create table crm.template (
  id         int generated always as identity primary key,
  kind       text not null check (kind in ('email', 'sms', 'call')),
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  subject    text check (length(subject) <= 500),
  body       text not null check (length(body) <= 10000),
  active     boolean not null default true,
  sort       smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by smallint,
  constraint template_kind_name unique (kind, name)
);

create table crm.list (
  id         int generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  note       text check (length(note) <= 1000),
  created_by smallint references crm.team_member (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index list_name_lower on crm.list (lower(name));

create table crm.list_member (
  list_id  int not null references crm.list (id) on delete cascade,
  entry_id int not null references crm.reg_entry (id),
  added_by smallint,
  added_at timestamptz not null default now(),
  primary key (list_id, entry_id)
);
create index list_member_entry on crm.list_member (entry_id);

create table crm.saved_view (
  id         int generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  scope      text not null check (scope in ('system', 'shared', 'private')),
  owner_id   smallint references crm.team_member (id),
  filter     jsonb not null,
  sort       jsonb,
  columns    text[],
  note       text check (length(note) <= 2000),
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_view_unique unique nulls not distinct (scope, owner_id, name)
);

create table crm.export_log (
  id         int generated always as identity primary key,
  format     text not null,
  target     jsonb not null,
  options    jsonb,
  total      int,
  created_by smallint,
  created_at timestamptz not null default now()
);

-- Validation ---------------------------------------------------------------------------------------------------------
create table crm.val_proposal (
  id              int generated always as identity primary key,
  kind            text not null check (kind in ('account_check', 'person', 'partner', 'email', 'domain', 'www', 'phone', 'reg_duplicate')),
  match_value     text not null,
  confidence      smallint not null check (confidence between 0 and 100),
  group_key       text not null,
  members         text[] not null,
  decided_members text[],
  new_members     text[] not null default '{}',
  status          smallint not null default 0 check (status between 0 and 3),
  last_run        smallint,
  decided_by      smallint,
  decided_at      timestamptz,
  note            text check (length(note) <= 2000),
  network_id      int,
  created_at      timestamptz not null default now(),
  constraint val_proposal_unique unique (kind, match_value)
);
create index val_proposal_status on crm.val_proposal (status, kind);
create index val_proposal_members on crm.val_proposal using gin (members);

create table crm.val_decision (
  id          int generated always as identity primary key,
  action      text not null check (action in ('detach', 'attach')),
  key_hash    bigint not null unique,
  account_key text,
  note        text check (length(note) <= 2000),
  decided_by  smallint,
  decided_at  timestamptz not null default now(),
  constraint val_decision_attach_target check (action <> 'attach' or account_key is not null)
);

create table crm.network (
  id         int generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  note       text check (length(note) <= 2000),
  created_by smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index network_name_lower on crm.network (lower(name));

create table crm.network_member (
  account_key text primary key,
  network_id  int not null references crm.network (id) on delete cascade,
  added_by    smallint,
  added_at    timestamptz not null default now()
);
create index network_member_network on crm.network_member (network_id);

-- Accounts that belong to an open proposal at or above the minimum confidence (used by derived validation). 'partner'
-- proposals are correct relations between a group practice or s.c. and its partner, not data problems (VAL-R2-2).
create view crm.v_open_member with (security_invoker = true) as -- SEC-14
  select distinct m as account_key
  from crm.val_proposal p cross join lateral unnest(p.members) as m
  where p.status = 0 and p.kind <> 'partner' and p.confidence >= coalesce((select (value #>> '{}')::int from crm.app_setting where key = 'val.minConfidence'), 50);

-- Row level security: enabled everywhere, deliberately without policies (deny-all for non-owner roles; the
-- SECURITY DEFINER functions run as the table owner and bypass it).
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'crm' and c.relkind = 'r' loop
    execute format('alter table crm.%I enable row level security', t.relname);
  end loop;
end $$;

-- System views (SPEC 7.6). Filters follow contract.ts LeadFilter; 'due' is a documented addition (CONTRACT Deviations).
insert into crm.saved_view (name, scope, filter, sort, note, sort_order) values
  ('POZ — podstawowa opieka zdrowotna', 'system',
   '{"kind":"p","sel":{"p.status":["aktywny"],"p.rodzaje":["Ambulatoryjne świadczenia zdrowotne"],"p.grp":["0"]}}',
   '{"key":"name","dir":"asc"}',
   'Aktywne podmioty lecznicze z działalnością ambulatoryjną i co najmniej jedną aktywną komórką grupy 0 (podstawowa opieka zdrowotna).', 10),
  ('Komercyjne centra wielospecjalistyczne (5+ poradni)', 'system',
   '{"kind":"p","sel":{"p.status":["aktywny"],"p.formType":["komercyjna"]},"spec1Min":5}',
   '{"key":"spec1","dir":"desc"}',
   'Aktywne podmioty o komercyjnej formie prawnej z co najmniej 5 różnymi poradniami specjalistycznymi (bez stomatologicznych 18xx). Próg zmienisz w filtrze „Liczba różnych poradni specjalistycznych”.', 20),
  ('Nowe wpisy — 12 mies.', 'system',
   '{"kind":"all","sel":{"p.status":["aktywny","nierozpoczety"],"r.status":["active"]},"wpisRel":12}',
   '{"key":"wpis","dir":"desc"}',
   'Podmioty i praktyki wpisane do rejestru w ostatnich 12 miesiącach (licząc od daty raportu ostatniego importu).', 30),
  ('Moje leady', 'system', '{"owner":["me"]}', '{"key":"nextStep","dir":"asc"}',
   'Leady, których opiekunem jesteś Ty.', 40),
  ('Do kontaktu dziś', 'system', '{"nextStep":"due","owner":["me"],"dnc":"exclude"}', '{"key":"nextStep","dir":"asc"}',
   'Moje leady z następnym krokiem na dziś lub zaległym (bez oznaczonych „nie kontaktować”).', 50);

-- Starter templates (editable in "Szablony"); variables are listed in SPEC 7.4.
insert into crm.template (kind, name, subject, body, sort) values
  ('email', 'Pierwszy kontakt', 'Współpraca z {{nazwa}}',
   E'Dzień dobry,\n\nnazywam się {{ja}} i reprezentuję Keep It Healthy. Piszę do {{nazwa}} ({{miasto}}), bo chciałbym krótko opowiedzieć o naszej ofercie dla placówek medycznych.\n\nCzy mogę zadzwonić w dogodnym terminie?\n\nPozdrawiam,\n{{ja}}\n{{ja_telefon}}\n{{ja_email}}', 10),
  ('email', 'Po rozmowie telefonicznej', 'Dziękuję za rozmowę — {{nazwa}}',
   E'Dzień dobry,\n\ndziękuję za dzisiejszą rozmowę. Zgodnie z ustaleniami przesyłam krótkie podsumowanie i pozostaję do dyspozycji.\n\nPozdrawiam,\n{{opiekun}}\n{{opiekun_telefon}}', 20),
  ('sms', 'Prośba o kontakt', NULL,
   'Dzień dobry, tu {{ja}} z Keep It Healthy. Próbowałem dodzwonić się do {{nazwa}}. Proszę o kontakt pod numer {{ja_telefon}}.', 10),
  ('call', 'Skrypt: pierwsza rozmowa', NULL,
   E'1. Przedstaw się: {{ja}}, Keep It Healthy.\n2. Zapytaj, czy rozmawiasz z osobą decyzyjną ({{nazwa}}).\n3. Potwierdź dane: adres ({{ulica}}, {{kod}} {{miasto}}), telefon, e-mail.\n4. Zapytaj o profil placówki i czy należy do sieci lub grupy.\n5. Ustal następny krok i zapisz wynik rozmowy w CRM.', 10);

select private.apply_api_grants();
