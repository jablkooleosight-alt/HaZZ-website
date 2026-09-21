-- HZS systém - schéma databáze pro Supabase
-- Bezpečné pustit opakovaně (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
-- takže tímhle skriptem můžeš jen doplnit chybějící tabulky/sloupce do stávající DB.
--
-- DŮLEŽITÉ: api/index.js posílá do Supabase (přes PostgREST) sloupce jako
-- "commanderId", "memberIds", "authorId" v přesně tomhle velbloudím zápisu.
-- Postgres bez uvozovek by tyhle názvy převedl na malá písmena (commanderid...)
-- a pak by je API nenašlo -> proto jsou v tomto skriptu schválně v uvozovkách.
-- Pokud už tabulku "incidents" máš založenou s jinými (malými) názvy sloupců,
-- tenhle skript k ní jen přidá správně pojmenované sloupce navíc - stará data
-- ve špatně pojmenovaných sloupcích se do nich automaticky nepřesunou. V tom
-- případě je jednodušší tabulku smazat a nechat ji skriptem založit znovu
-- (pokud v ní nejsou důležitá data - výjezdy/směrnice/vozidla se stejně
-- dosud neukládaly kvůli bugu, který jsme právě opravili).

-- ==================== ČLENOVÉ ====================

create table if not exists members (
  id text primary key,
  name text,
  rank text,
  number text,
  joined timestamptz,
  avatar text,
  on_duty boolean default false,
  duty_start bigint,                 -- Date.now() z prohlížeče (ms), ne timestamp
  total_duty_seconds integer default 0,
  duties_history jsonb default '[]'::jsonb,
  weekly_bonuses jsonb default '{}'::jsonb
);

alter table members add column if not exists name text;
alter table members add column if not exists rank text;
alter table members add column if not exists number text;
alter table members add column if not exists joined timestamptz;
alter table members add column if not exists avatar text;
alter table members add column if not exists on_duty boolean default false;
alter table members add column if not exists duty_start bigint;
alter table members add column if not exists total_duty_seconds integer default 0;
alter table members add column if not exists duties_history jsonb default '[]'::jsonb;
alter table members add column if not exists weekly_bonuses jsonb default '{}'::jsonb;

-- Oprava starších řádků: weekly_bonuses omylem jako pole [] místo objektu {}
-- (kvůli tomu se prémie tiše neukládaly - viz commit s opravou v api/index.js).
update members set weekly_bonuses = '{}'::jsonb where jsonb_typeof(weekly_bonuses) = 'array';

-- ==================== VÝJEZDY ====================

create table if not exists incidents (
  id text primary key,
  number text,
  datetime timestamptz,
  type text,
  location text,
  units jsonb default '[]'::jsonb,
  "memberIds" jsonb default '[]'::jsonb,
  "commanderId" text,
  description text,
  result text,
  status text default 'pending',
  "authorId" text
);

alter table incidents add column if not exists number text;
alter table incidents add column if not exists datetime timestamptz;
alter table incidents add column if not exists type text;
alter table incidents add column if not exists location text;
alter table incidents add column if not exists units jsonb default '[]'::jsonb;
alter table incidents add column if not exists "memberIds" jsonb default '[]'::jsonb;
alter table incidents add column if not exists "commanderId" text;
alter table incidents add column if not exists description text;
alter table incidents add column if not exists result text;
alter table incidents add column if not exists status text default 'pending';
alter table incidents add column if not exists "authorId" text;

create index if not exists idx_incidents_datetime on incidents (datetime desc);
create index if not exists idx_incidents_status on incidents (status);

-- ==================== SMĚRNICE ====================

create table if not exists guidelines (
  id text primary key,
  title text,
  category text,
  content text,
  date timestamptz
);

alter table guidelines add column if not exists title text;
alter table guidelines add column if not exists category text;
alter table guidelines add column if not exists content text;
alter table guidelines add column if not exists date timestamptz;

create index if not exists idx_guidelines_date on guidelines (date desc);

-- ==================== VOZIDLA (Kniha jízd) ====================

create table if not exists vehicles (
  id text primary key,
  name text,
  type text,
  status text,
  note text
);

alter table vehicles add column if not exists name text;
alter table vehicles add column if not exists type text;
alter table vehicles add column if not exists status text;
alter table vehicles add column if not exists note text;

-- ==================== RLS ====================
-- Autorizaci (kdo smí co dělat) řeší backend (api/index.js) podle hodnosti
-- z podepsané session cookie - Supabase klíč používá výhradně server, nikdy
-- prohlížeč. Row Level Security proto na těchto tabulkách vypínáme, aby
-- nešlapala backendu pod nohy; pokud chceš RLS zapnuté jako druhou vrstvu
-- obrany, je potřeba místo "disable" napsat policy povolující přístup roli,
-- pod kterou backend do Supabase přistupuje.

alter table members disable row level security;
alter table incidents disable row level security;
alter table guidelines disable row level security;
alter table vehicles disable row level security;
