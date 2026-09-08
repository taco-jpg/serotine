import { MessageSquare, Lock, KeyRound } from "lucide-react"

export default function ChatIndexPage() {
  return <div className="flex h-full flex-col items-center justify-center p-10 text-center">
    <div className="mb-7 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5"><MessageSquare className="size-10 text-indigo-300" /></div>
    <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Your private space</p>
    <h1 className="mb-4 text-4xl text-zinc-200">A conversation starts with trust.</h1>
    <p className="max-w-md text-base leading-relaxed text-zinc-500">Share your address, add a contact, and choose a conversation. Your messages are encrypted on your device.</p>
    <div className="mt-12 flex max-w-lg gap-8 border-t border-zinc-800/70 pt-6 text-left"><div><Lock className="mb-3 size-4 text-zinc-500" /><p className="text-sm text-zinc-400">Private messages</p><p className="mt-1 text-sm leading-relaxed text-zinc-600">The relay handles encrypted content.</p></div><div><KeyRound className="mb-3 size-4 text-zinc-500" /><p className="text-sm text-zinc-400">Keep your backup</p><p className="mt-1 text-sm leading-relaxed text-zinc-600">Your key is your access. Store it safely.</p></div></div>
  </div>
}
