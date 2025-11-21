"use server"

import { createAdminClient } from "@/utils/supabase/admin"
import { createClient } from "@/utils/supabase/server"
import { revalidatePath } from "next/cache"

export async function signUpWithUsername(username: string, password: string, email: string) {
  try {
    const supabase = createAdminClient()

    console.log("[v0] Checking for existing username:", username)

    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("username")
      .eq("username", username)
      .maybeSingle()

    if (existingProfile) {
      console.log("[v0] Username already exists")
      return { error: "Username is already taken" }
    }

    console.log("[v0] Creating user with email:", email, "and username:", username)

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username },
    })

    if (error) {
      console.error("[v0] Supabase auth error:", error)
      return { error: error.message }
    }

    console.log("[v0] User created successfully:", data.user?.id)
    return { success: true }
  } catch (error: any) {
    console.error("[v0] Admin signup error:", error)
    return { error: error.message || "An unexpected error occurred" }
  }
}

export async function updateProfile(data: { username?: string; full_name?: string; avatar_url?: string }) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return { error: "Not authenticated" }
    }

    // If updating username, check if it's already taken
    if (data.username) {
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("username")
        .eq("username", data.username)
        .neq("id", user.id)
        .maybeSingle()

      if (existingProfile) {
        return { error: "Username is already taken" }
      }
    }

    const { error } = await supabase.from("profiles").update(data).eq("id", user.id)

    if (error) {
      return { error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("Update profile error:", error)
    return { error: error.message || "An unexpected error occurred" }
  }
}

export async function createGroup(name: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error("Not authenticated")
  }

  // 1. Create the group
  const { data: group, error: groupError } = await supabase
    .from("chat_groups")
    .insert({
      name: name.trim(),
      created_by: user.id,
    })
    .select()
    .single()

  if (groupError) {
    console.error("Error creating group:", groupError)
    throw new Error("Failed to create group")
  }

  // 2. Add creator as member
  const { error: memberError } = await supabase.from("chat_group_members").insert({
    group_id: group.id,
    user_id: user.id,
  })

  if (memberError) {
    console.error("Error adding member:", memberError)
    // Cleanup group if member addition fails
    await supabase.from("chat_groups").delete().eq("id", group.id)
    throw new Error("Failed to join group")
  }

  revalidatePath("/dashboard/messages")
  return group
}

export async function createGroupProposal(data: {
  groupId: string
  title: string
  description: string
  type: string
  targetValue?: any
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error("Not authenticated")
  }

  const proposalData: any = {
    group_id: data.groupId,
    author_id: user.id,
    title: data.title,
    description: data.description,
    type: data.type,
    status: "active",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours expiry
  }

  if (data.type === "change_quorum") {
    proposalData.new_quorum = Number.parseInt(data.targetValue)
  } else if (data.type === "add_member" || data.type === "remove_member") {
    proposalData.target_user_id = data.targetValue
  }

  const { data: proposal, error } = await supabase.from("proposals").insert(proposalData).select().single()

  if (error) {
    console.error("Error creating proposal:", error)
    throw new Error(error.message)
  }

  revalidatePath(`/dashboard/messages/${data.groupId}`)
  revalidatePath(`/dashboard/groups`)
  return proposal
}

export async function voteOnProposal(proposalId: string, voteType: "for" | "against") {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error("Not authenticated")
  }

  // Check if user already voted
  const { data: existingVote } = await supabase
    .from("votes")
    .select("id")
    .eq("proposal_id", proposalId)
    .eq("voter_id", user.id)
    .single()

  if (existingVote) {
    // Update existing vote
    const { error } = await supabase.from("votes").update({ vote_type: voteType }).eq("id", existingVote.id)

    if (error) {
      throw new Error(error.message)
    }
  } else {
    // Insert new vote
    const { error } = await supabase.from("votes").insert({
      proposal_id: proposalId,
      voter_id: user.id,
      vote_type: voteType,
    })

    if (error) {
      throw new Error(error.message)
    }
  }

  revalidatePath("/dashboard/groups")
  return { success: true }
}
