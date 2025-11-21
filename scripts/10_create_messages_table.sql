-- Create chat_messages table for persistent history
create table if not exists public.chat_messages (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.chat_groups(id) on delete cascade not null,
  sender_id uuid references auth.users(id) on delete cascade not null,
  content text not null, -- Encrypted content blob
  content_iv text not null, -- IV for the content
  recipient_keys jsonb not null, -- Map of user_id -> { ciphertext, iv }
  created_at timestamp with time zone default now()
);

-- Enable RLS
alter table public.chat_messages enable row level security;

-- Policies
create policy "Group members can view messages"
  on public.chat_messages for select
  using (
    exists (
      select 1 from public.chat_group_members
      where chat_group_members.group_id = chat_messages.group_id
      and chat_group_members.user_id = auth.uid()
    )
  );

create policy "Group members can insert messages"
  on public.chat_messages for insert
  with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.chat_group_members
      where chat_group_members.group_id = chat_messages.group_id
      and chat_group_members.user_id = auth.uid()
    )
  );

-- Index for faster queries
create index if not exists idx_chat_messages_group_id on public.chat_messages(group_id);
create index if not exists idx_chat_messages_created_at on public.chat_messages(created_at);
