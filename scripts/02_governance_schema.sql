-- Create proposals table
create table if not exists public.proposals (
  id uuid default gen_random_uuid() primary key,
  author_id uuid references public.profiles(id) on delete cascade not null,
  title text not null,
  description text not null,
  status text default 'active' check (status in ('active', 'passed', 'rejected')),
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone default now()
);

-- Create votes table
create table if not exists public.votes (
  id uuid default gen_random_uuid() primary key,
  proposal_id uuid references public.proposals(id) on delete cascade not null,
  voter_id uuid references public.profiles(id) on delete cascade not null,
  vote_type text not null check (vote_type in ('for', 'against')),
  created_at timestamp with time zone default now(),
  
  unique(proposal_id, voter_id)
);

-- RLS for proposals
alter table public.proposals enable row level security;

create policy "Proposals are viewable by everyone."
  on public.proposals for select
  using ( true );

create policy "Authenticated users can create proposals."
  on public.proposals for insert
  with check ( auth.uid() = author_id );

-- RLS for votes
alter table public.votes enable row level security;

create policy "Votes are viewable by everyone."
  on public.votes for select
  using ( true );

create policy "Authenticated users can vote."
  on public.votes for insert
  with check ( auth.uid() = voter_id );

create policy "Users can change their vote."
  on public.votes for update
  using ( auth.uid() = voter_id );
