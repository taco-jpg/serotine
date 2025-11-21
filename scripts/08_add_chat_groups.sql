-- Create chat_groups table
create table if not exists public.chat_groups (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  created_by uuid references public.profiles(id) on delete cascade not null,
  created_at timestamp with time zone default now()
);

-- Create chat_group_members table
create table if not exists public.chat_group_members (
  group_id uuid references public.chat_groups(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  joined_at timestamp with time zone default now(),
  primary key (group_id, user_id)
);

-- Enable RLS
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;

-- Policies for chat_groups
create policy "Users can view groups they are members of"
  on public.chat_groups for select
  using (
    exists (
      select 1 from public.chat_group_members
      where group_id = public.chat_groups.id
      and user_id = auth.uid()
    )
  );

create policy "Users can create groups"
  on public.chat_groups for insert
  with check ( auth.uid() = created_by );

-- Policies for chat_group_members
create policy "Users can view members of their groups"
  on public.chat_group_members for select
  using (
    exists (
      select 1 from public.chat_group_members as members
      where members.group_id = public.chat_group_members.group_id
      and members.user_id = auth.uid()
    )
  );

create policy "Users can add members to their groups"
  on public.chat_group_members for insert
  with check (
    -- Allow adding yourself (when creating group)
    auth.uid() = user_id
    OR
    -- Allow adding others if you are already a member (simplified for now)
    exists (
      select 1 from public.chat_group_members
      where group_id = public.chat_group_members.group_id
      and user_id = auth.uid()
    )
  );
