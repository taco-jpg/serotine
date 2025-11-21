-- Create chat_groups table if it doesn't exist
create table if not exists public.chat_groups (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  created_by uuid references auth.users(id),
  created_at timestamp with time zone default now()
);

-- Create chat_group_members table if it doesn't exist
create table if not exists public.chat_group_members (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.chat_groups(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  joined_at timestamp with time zone default now(),
  unique(group_id, user_id)
);

-- Enable RLS
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;

-- Helper function to check membership without recursion (SECURITY DEFINER breaks the loop)
create or replace function public.is_group_member(_group_id uuid)
returns boolean as $$
begin
  return exists (
    select 1
    from public.chat_group_members
    where group_id = _group_id
    and user_id = auth.uid()
  );
end;
$$ language plpgsql security definer;

-- Policies for chat_groups
drop policy if exists "Users can view groups they are members of" on public.chat_groups;
create policy "Users can view groups they are members of"
  on public.chat_groups for select
  using ( public.is_group_member(id) );

drop policy if exists "Users can insert groups" on public.chat_groups;
create policy "Users can insert groups"
  on public.chat_groups for insert
  with check ( auth.uid() = created_by );

-- Policies for chat_group_members
drop policy if exists "Users can view members of their groups" on public.chat_group_members;
create policy "Users can view members of their groups"
  on public.chat_group_members for select
  using ( public.is_group_member(group_id) );

drop policy if exists "Users can insert members" on public.chat_group_members;
create policy "Users can insert members"
  on public.chat_group_members for insert
  with check ( 
    -- Allow users to join groups (or be added by creator - simplified for now)
    auth.uid() = user_id 
    or 
    exists (select 1 from public.chat_groups where id = group_id and created_by = auth.uid())
  );
