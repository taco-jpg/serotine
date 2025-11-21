-- Drop existing policies to ensure clean state
drop policy if exists "Users can view groups they are members of" on public.chat_groups;
drop policy if exists "Users can insert groups" on public.chat_groups;
drop policy if exists "Users can view members of their groups" on public.chat_group_members;
drop policy if exists "Users can insert members" on public.chat_group_members;
drop policy if exists "Users can view groups" on public.chat_groups;
drop policy if exists "Users can update groups" on public.chat_groups;
drop policy if exists "Users can delete groups" on public.chat_groups;
drop policy if exists "Users can view members" on public.chat_group_members;
drop policy if exists "Users can delete members" on public.chat_group_members;

-- Re-create helper function
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

-- Chat Groups Policies

-- Allow users to view groups they are members of OR groups they created
create policy "Users can view groups"
  on public.chat_groups for select
  using ( 
    public.is_group_member(id) 
    or 
    created_by = auth.uid() 
  );

-- Allow users to insert groups if they set themselves as creator
create policy "Users can insert groups"
  on public.chat_groups for insert
  with check ( 
    auth.uid() = created_by 
  );

-- Allow users to update groups they created
create policy "Users can update groups"
  on public.chat_groups for update
  using ( created_by = auth.uid() );

-- Allow users to delete groups they created
create policy "Users can delete groups"
  on public.chat_groups for delete
  using ( created_by = auth.uid() );

-- Chat Group Members Policies

-- Allow users to view members of groups they belong to
create policy "Users can view members"
  on public.chat_group_members for select
  using ( public.is_group_member(group_id) );

-- Allow users to join groups (insert themselves)
-- OR allow group creators to add members
create policy "Users can insert members"
  on public.chat_group_members for insert
  with check ( 
    -- User adding themselves
    auth.uid() = user_id 
    or 
    -- Group creator adding someone
    exists (
      select 1 
      from public.chat_groups 
      where id = group_id 
      and created_by = auth.uid()
    )
  );

-- Allow users to leave groups (delete themselves)
-- OR allow group creators to remove members
create policy "Users can delete members"
  on public.chat_group_members for delete
  using ( 
    -- User removing themselves
    auth.uid() = user_id 
    or 
    -- Group creator removing someone
    exists (
      select 1 
      from public.chat_groups 
      where id = group_id 
      and created_by = auth.uid()
    )
  );
