-- Drop the messages table to ensure ciphertext never touches the server (Requirement 1)
DROP TABLE IF EXISTS public.chat_messages;

-- Update profiles table (Requirement 7)
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS nickname text;

-- Update chat_groups table for governance (Requirement 5)
ALTER TABLE public.chat_groups
ADD COLUMN IF NOT EXISTS quorum_percentage integer DEFAULT 50 CHECK (quorum_percentage > 0 AND quorum_percentage <= 100),
ADD COLUMN IF NOT EXISTS last_quorum_change timestamp with time zone DEFAULT now();

-- Update proposals table for group-specific governance (Requirement 5)
ALTER TABLE public.proposals
ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.chat_groups(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS type text CHECK (type IN ('add_member', 'remove_member', 'change_quorum', 'general')) DEFAULT 'general',
ADD COLUMN IF NOT EXISTS target_user_id uuid REFERENCES public.profiles(id),
ADD COLUMN IF NOT EXISTS new_quorum integer CHECK (new_quorum > 0 AND new_quorum <= 100);

-- Add RLS policy for group proposals
CREATE POLICY "Group members can view proposals"
  ON public.proposals FOR SELECT
  USING (
    group_id IS NULL OR -- Keep global proposals visible if any
    EXISTS (
      SELECT 1 FROM public.chat_group_members
      WHERE group_id = public.proposals.group_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Group members can create proposals"
  ON public.proposals FOR INSERT
  WITH CHECK (
    group_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.chat_group_members
      WHERE group_id = public.proposals.group_id
      AND user_id = auth.uid()
    )
  );
