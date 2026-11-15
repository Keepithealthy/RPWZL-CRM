-- Team, settings, pipeline statuses, tags, generic domains (DATA_MODEL 4.4, 5). Reference data seeded here is public
-- (no personal data); the allowlist itself is filled by the owner (OPERATIONS) or by seed.sql locally.

create table crm.team_member (
  id           smallint generated always as identity primary key,
  email        text not null,
  display_name text not null check (length(btrim(display_name)) > 0),
  role         text not null check (role in ('owner', 'member')),
  phone        text,
  active       boolean not null default true,
  user_id      uuid unique,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint team_member_email_lower check (email = lower(email)),
  constraint team_member_email_unique unique (email)
);

create table crm.app_setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by smallint references crm.team_member (id)
);

create table crm.lead_status (
  id         smallint generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0),
  color      text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort       smallint not null default 0,
  stage      text not null default 'open' check (stage in ('open', 'won', 'lost', 'paused')),
  is_default boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by smallint
);
create unique index lead_status_name_active on crm.lead_status (lower(name)) where active;
create unique index lead_status_one_default on crm.lead_status ((true)) where is_default;

create table crm.tag (
  id         smallint generated always as identity primary key,
  name       text not null check (length(btrim(name)) > 0),
  color      text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by smallint
);
create unique index tag_name_lower on crm.tag (lower(name));

create table crm.generic_domain (
  domain     text primary key check (domain = lower(domain) and length(domain) between 3 and 253),
  kind       text not null check (kind in ('free', 'generic', 'typo', 'social')),
  suggestion text,
  source     text not null default 'seed' check (source in ('seed', 'auto', 'owner')),
  updated_at timestamptz not null default now()
);

-- Reference data ---------------------------------------------------------------------------------------------------

insert into crm.lead_status (name, color, sort, stage, is_default) values
  ('Nowy',              '#64748b', 10, 'open',   true),
  ('Do kontaktu',       '#2563eb', 20, 'open',   false),
  ('Kontakt nawiązany', '#0891b2', 30, 'open',   false),
  ('Zainteresowany',    '#7c3aed', 40, 'open',   false),
  ('Spotkanie',         '#c026d3', 50, 'open',   false),
  ('Oferta',            '#d97706', 60, 'open',   false),
  ('Klient',            '#16a34a', 70, 'won',    false),
  ('Nie teraz',         '#a16207', 80, 'paused', false),
  ('Odrzucony',         '#dc2626', 90, 'lost',   false);

insert into crm.app_setting (key, value) values
  ('ui.staleDays',      '35'),
  ('val.minConfidence', '50'),
  ('val.params',        '{"genericDomainAccounts":30,"emailClusterMax":30,"domainClusterMax":50,"wwwClusterMax":50,"phoneClusterMax":3,"staleBefore":"2023-11-10"}'),
  ('sms.diacritics',    '"keep"'),
  ('history.keepRuns',  '24'),
  ('export.defaults',   '{}');

insert into crm.generic_domain (domain, kind) select d, 'free' from unnest(array[
  'gmail.com','googlemail.com','wp.pl','o2.pl','onet.pl','onet.eu','op.pl','poczta.onet.pl','poczta.onet.eu','vp.pl',
  'interia.pl','interia.eu','poczta.fm','tlen.pl','go2.pl','gazeta.pl','yahoo.com','yahoo.pl','hotmail.com','outlook.com',
  'live.com','icloud.com','me.com','protonmail.com','proton.me','autograf.pl','buziaczek.pl','int.pl','neostrada.pl',
  'post.pl','pro.onet.pl','vip.onet.pl','poczta.wp.pl','xl.wp.pl','wp.eu','onet.com.pl','spoko.pl','hot.pl','list.pl',
  'adres.pl','data.pl',
  'aol.com','yahoo.co.uk','yahoo.it','hoga.pl','opoczta.pl','epoczta.pl','e-poczta.pl','poczta.pl','pocztaplus.pl',
  'upcpoczta.pl','pocztaemail.pl','europoczta.pl','vip.interia.pl','poczta.interia.pl','poczta.neostrada.pl',
  'poczta.internetdsl.pl','esculap.pl','eskulap.pl','orange.pl','plusnet.pl','idsl.pl',
  'ka.onet.pl','za.onet.pl','ns.onet.pl','le.onet.pl',
  'mail.ru','ukr.net','windowslive.com','yahoo.de','yahoo.fr','yahoo.es','protonmail.ch','gmx.com','gmx.net','aol.pl',
  'mail.com','ymail.com','konto.pl','prokonto.pl','box43.pl','eskrzynka.pl','1gb.pl','10g.pl','go3.pl','internetdsl.pl',
  'pnet.pl','inet.com.pl','inetia.pl','rubikon.pl','dilnet.wroc.pl','life.pl','os.pl','oz.pl','dentonet.pl',
  -- ISP / portal mailboxes under shared suffixes (VAL-R3-7); a free row covers its sub-domains
  'ape.net.pl','alias.net.pl','ak.net.pl','toya.net.pl','uznam.net.pl','krynica.net.pl','malbork.net.pl','konin.lm.pl',
  'creator.wroc.pl','gryf.info.pl','amorki.pl','mierzeja.pl','2com.pl','tpnet.pl','mail.pl','opoka.org.pl','kkw.com.pl',
  -- city portals and an ISP whose mailboxes link unrelated local podmioty (VAL-R4-3)
  'elblag.com.pl','sanok.com.pl','grudziadz.com.pl','tenit.com.pl','sanatoria.com.pl',
  -- a long-standing ISP (VAL-R5-4)
  'iq.pl']) as d;

insert into crm.generic_domain (domain, kind, suggestion) values
  ('gmial.com','typo','gmail.com'), ('gmai.com','typo','gmail.com'), ('gmail.pl','typo','gmail.com'),
  ('gmail.con','typo','gmail.com'), ('gmal.com','typo','gmail.com'), ('gamil.com','typo','gmail.com'),
  ('wp.p','typo','wp.pl'), ('0net.pl','typo','onet.pl'), ('intera.pl','typo','interia.pl'), ('o2.p','typo','o2.pl'),
  ('gmail.com.pl','typo','gmail.com'), ('gemail.com','typo','gmail.com'), ('gmali.com','typo','gmail.com'),
  ('interia.com','typo','interia.pl'), ('poczta.fm.pl','typo','poczta.fm'), ('pocztafm.pl','typo','poczta.fm'),
  ('onet.poczta.pl','typo','poczta.onet.pl'), ('oent.pl','typo','onet.pl'), ('onte.pl','typo','onet.pl'),
  ('noet.pl','typo','onet.pl'), ('ont.pl','typo','onet.pl'), ('oet.pl','typo','onet.pl'),
  ('xlwp.pl','typo','wp.pl'), ('onwt.pl','typo','onet.pl'), ('o.2.pl','typo','o2.pl'), ('oo2.pl','typo','o2.pl'),
  ('proonet.pl','typo','onet.pl'), ('plsnet.pl','typo','onet.pl'), ('tlan.pl','typo','tlen.pl'),
  ('poczta.internetds.pl','typo','poczta.internetdsl.pl'), ('tlen.pl.pl','typo','tlen.pl'), ('poczta.onrt.pl','typo','poczta.onet.pl'),
  ('poczta.onet','typo','poczta.onet.pl'), ('poczta.one.pl','typo','poczta.onet.pl'), ('pocta.onet.pl','typo','poczta.onet.pl'),
  ('02.pl','typo','o2.pl'), ('poczta.net.pl','typo','onet.pl'),
  -- a bare public suffix as e-mail domain (x@com.pl) is a typo without a suggestion; a typo row matches only itself (VAL-R4-3)
  ('com.pl','typo',null), ('net.pl','typo',null), ('org.pl','typo',null), ('edu.pl','typo',null), ('waw.pl','typo',null);

-- generic = shared by unrelated institutions: the entry matches the domain itself and every sub-domain (*.gov.pl ...).
-- Public second-level suffixes (com.pl, net.pl, edu.pl ...) are never listed here: they would hide every company under
-- them (VAL-R3-1), and private.domain_class never lets such a row cover sub-domains (private.public_suffix).
insert into crm.generic_domain (domain, kind) values
  ('gov.pl','generic'), ('mil.pl','generic'), ('mp.pl','generic'), ('zoz.org.pl','generic'), ('home.pl','generic'),
  ('webmedia.com.pl','generic'), ('bitserwis.pl','generic'), ('strazgraniczna.pl','generic'),
  ('lzlrp.pl','generic'), ('porozumieniepodkarpackie.pl','generic'),
  -- regional NFZ branch domains used by unrelated practices, a school network domain (VAL-R3-7)
  ('nfz-bialystok.pl','generic'), ('nfz-bydgoszcz.pl','generic'), ('nfz-gdansk.pl','generic'), ('nfz-katowice.pl','generic'),
  ('nfz-kielce.pl','generic'), ('nfz-krakow.pl','generic'), ('nfz-lodz.pl','generic'), ('nfz-lublin.pl','generic'),
  ('nfz-olsztyn.pl','generic'), ('nfz-opole.pl','generic'), ('nfz-poznan.pl','generic'), ('nfz-rzeszow.pl','generic'),
  ('nfz-szczecin.pl','generic'), ('nfz-warszawa.pl','generic'), ('nfz-wroclaw.pl','generic'), ('nfz-zielonagora.pl','generic'),
  ('nfz.gov.pl','generic'), ('teb-edukacja.pl','generic'),
  -- medical universities: staff addresses link unrelated practices and companies (VAL-R4-3; rules.ts GENERIC_UNIVERSITIES)
  ('gumed.edu.pl','generic'), ('ump.edu.pl','generic'), ('umb.edu.pl','generic'), ('wum.edu.pl','generic'), ('sum.edu.pl','generic'),
  ('pum.edu.pl','generic'), ('umw.edu.pl','generic'), ('umed.wroc.pl','generic'), ('umed.lodz.pl','generic'), ('umlub.pl','generic'),
  ('uj.edu.pl','generic'), ('cm-uj.krakow.pl','generic'), ('cm.umk.pl','generic'), ('umk.pl','generic');

insert into crm.generic_domain (domain, kind) select d, 'social' from unnest(array[
  'facebook.com','fb.com','m.facebook.com','instagram.com','linkedin.com','twitter.com','x.com','youtube.com',
  'znanylekarz.pl','google.com','goo.gl','business.site',
  'sites.google.com','osoz.pl','lekarzebezkolejki.pl','stomatolog.pl','linktr.ee',
  'google.pl','mail.google.com','republika.pl','webd.pl','znajdzfizjoterapeute.pl','kliniki.pl','dobrylekarz.pro','konopnaterapia.com',
  'medycyna.net.pl']) as d;

select private.apply_api_grants();
