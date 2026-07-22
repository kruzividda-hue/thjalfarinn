-- Þjálfarinn - gagnagrunnsskema fyrir Supabase
-- Keyrðu þetta í SQL Editor í Supabase (Dashboard -> SQL Editor -> New query -> líma inn -> Run)

-- Prófíll notanda (svör úr spurningalista o.fl.)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Æfingaplön (AI býr til; aðeins eitt virkt í einu)
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists plans_user_active_idx on public.plans (user_id, active, created_at desc);

-- Skráðar æfingar (log) + endurgjöf eftir æfingu
create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete set null,
  workout_key text not null,
  log jsonb not null,
  feedback jsonb,
  created_at timestamptz not null default now()
);
create index if not exists workout_logs_user_idx on public.workout_logs (user_id, created_at desc);

-- Líkamsþyngd yfir tíma
create table if not exists public.weight_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weight_kg numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists weight_logs_user_idx on public.weight_logs (user_id, created_at desc);

-- Spjall við AI-þjálfarann
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on public.chat_messages (user_id, created_at);

-- Row Level Security: hver notandi sér aðeins sín eigin gögn
alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.workout_logs enable row level security;
alter table public.weight_logs enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own plans" on public.plans;
create policy "own plans" on public.plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own workout_logs" on public.workout_logs;
create policy "own workout_logs" on public.workout_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own weight_logs" on public.weight_logs;
create policy "own weight_logs" on public.weight_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own chat_messages" on public.chat_messages;
create policy "own chat_messages" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
