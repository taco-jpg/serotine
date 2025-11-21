-- Create friends table
create table if not exists public.friends (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  friend_id uuid references public.profiles(id) on delete cascade not null,
  status text check (status in ('pending', 'accepted')) default 'pending',
  created_at timestamp with time zone default now(),
  
  unique(user_id, friend_id)
);

-- Set up RLS for friends
alter table public.friends enable row level security;

create policy "Users can view their own friends."
  on public.friends for select
  using ( auth.uid() = user_id or auth.uid() = friend_id );

create policy "Users can insert friend requests."
  on public.friends for insert
  with check ( auth.uid() = user_id );

create policy "Users can update their own friend requests."
  on public.friends for update
  using ( auth.uid() = user_id or auth.uid() = friend_id );

create policy "Users can delete their own friends."
  on public.friends for delete
  using ( auth.uid() = user_id or auth.uid() = friend_id );
