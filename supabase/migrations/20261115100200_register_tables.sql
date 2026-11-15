-- Register tables (DATA_MODEL 3). Writer: import RPCs only. Sizes measured in DATA_MODEL 9.

create table crm.reg_dict (
  id    smallint generated always as identity primary key,
  facet text not null,
  val   text not null,
  label text,
  constraint reg_dict_unique unique (facet, val)
);

create table crm.import_run (
  id               int generated always as identity primary key,
  status           text not null default 'running' check (status in ('running', 'applied', 'failed', 'aborted')),
  file_name        text,
  file_sha256      text,
  index_version    smallint,
  hash_version     smallint,
  index_created_at timestamptz,
  tool_today       date,
  report_date      date,
  sources          jsonb,
  full_sources     text[] not null default '{}',
  preview          jsonb,
  counts           jsonb,
  started_by       smallint not null references crm.team_member (id),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  error            text
);
create unique index import_run_one_running on crm.import_run ((true)) where status = 'running';

create table crm.reg_entry (
  id                 int generated always as identity primary key,
  key_hash           bigint not null,
  kind               "char" not null check (kind in ('p', 'r')),
  src                smallint not null check (src between 0 and 8),
  reg_org            smallint not null,
  ks                 text not null,
  kseq               smallint not null default 1,
  name               text,
  nip                text,
  nip_status         smallint not null,
  entity_type        smallint not null,
  account_key        text not null,
  account_size       smallint not null default 1,
  is_account_primary boolean not null default true,
  fv                 smallint[] not null,
  emails             text[],
  nums               int[],
  email              text,
  tel                text,
  www                text,
  mobile             int,
  tel_norm           int,
  tel_shared         int,
  cflags             smallint not null default 0,
  miasto             text,
  kod                text,
  wpis               date,
  stan               date,
  nz                 smallint,
  nk                 int,
  spec1              smallint,
  q_email            smallint,
  q_phone            smallint,
  qflags             int not null default 0,
  in_register        boolean not null default true,
  first_run          smallint,
  last_change_run    smallint,
  gone_run           smallint,
  h_all              bigint not null,
  h_contact          bigint not null,
  h_derived          bigint not null
);
-- Deviation from DATA_MODEL 3.2 (see CONTRACT Deviations): account_key is indexed completely, not only for
-- account_size > 1, because proposal members and network members are mostly single-entry accounts.
create unique index reg_entry_key_hash on crm.reg_entry (key_hash);
create index reg_entry_fv on crm.reg_entry using gin (fv);
create index reg_entry_nums on crm.reg_entry using gin (nums);
create index reg_entry_emails on crm.reg_entry using gin (emails);
create index reg_entry_account on crm.reg_entry (account_key);

create table crm.reg_detail_block (
  block_no int primary key,
  recs     text compression pglz not null
);

create table crm.reg_change (
  run_id   smallint not null,
  entry_id int not null,
  change   smallint not null check (change in (1, 2)),
  fields   int not null,
  old      jsonb,
  primary key (entry_id, run_id)
);
create index reg_change_run on crm.reg_change (run_id, change);

-- Pending/open-proposal membership used by validation filters.
select private.apply_api_grants();
