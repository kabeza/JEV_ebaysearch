-- Full schema from the design spec, section 7. Create-if-not-exists so startup is idempotent.

create table if not exists searches (
  id            integer primary key autoincrement,
  name          text not null,
  keyword       text not null,
  criteria_text text not null default '',
  spec_json     text not null default '{}',
  settings_json text not null default '{}',
  created_at    text not null default (datetime('now')),
  updated_at    text not null default (datetime('now'))
);

create table if not exists runs (
  id            integer primary key autoincrement,
  search_id     integer not null references searches(id) on delete cascade,
  status        text not null default 'queued',
  started_at    text,
  finished_at   text,
  settings_json text not null default '{}',
  stats_json    text not null default '{}',
  error         text
);

create table if not exists listings (
  id               integer primary key autoincrement,
  run_id           integer not null references runs(id) on delete cascade,
  ebay_item_id     text,
  title            text not null default '',
  url              text,
  price            real,
  shipping         real,
  currency         text,
  condition_label  text,
  seller_json      text,
  is_refurb        integer not null default 0,
  raw_card_json    text,
  raw_detail_json  text,
  stage            text not null default 'card_only',
  reject_reason    text
);
create index if not exists idx_listings_run on listings(run_id);
-- One row per eBay item per run: a re-fetched page cannot duplicate listings.
create unique index if not exists idx_listings_run_item on listings(run_id, ebay_item_id);

create table if not exists questionnaires (
  id              integer primary key autoincrement,
  run_id          integer not null references runs(id) on delete cascade,
  definition_json text not null,
  version         integer not null default 1,
  created_at      text not null default (datetime('now'))
);

create table if not exists judgments (
  id               integer primary key autoincrement,
  run_id           integer not null references runs(id) on delete cascade,
  questionnaire_id integer not null references questionnaires(id) on delete cascade,
  listing_id       integer not null references listings(id) on delete cascade,
  question_key     text not null,
  answer_json      text not null,
  created_at       text not null default (datetime('now'))
);
create index if not exists idx_judgments_listing on judgments(listing_id);

create table if not exists events (
  id           integer primary key autoincrement,
  run_id       integer not null references runs(id) on delete cascade,
  seq          integer not null,
  at           text not null default (datetime('now')),
  type         text not null,
  payload_json text
);
create index if not exists idx_events_run_seq on events(run_id, seq);
