"use client"

import { useState, useRef, useEffect } from "react"
import { Shield, Send, Lock, Zap } from "lucide-react"
import { useP2PChat } from "@/hooks/use-p2p-chat"
import { IdentityIcon } from "@/components/ui/identity-icon"

// Utility
const formatPubKey = (key: string) => {
  if (!key) return ""
  if (key.length <= 10) return key
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const targetPubKey = params.pubkey
  const { sendMessage, status, messages, myPub } = useP2PChat(targetPubKey)
  const [content, setContent] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  
  const [alias, setAlias] = useState("")

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    const saved = localStorage.getItem("serotine_contacts_v2")
    if (saved) {
      const parsed = JSON.parse(saved)
      const contact = parsed.find((c: any) => c.pub === targetPubKey)
      if (contact && contact.alias) setAlias(contact.alias)
    }
  }, [targetPubKey])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!content.trim()) return
    await sendMessage(content)
    setContent("")
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 relative selection:bg-zinc-800">
      {/* Top Bar */}
      <div className="h-16 border-b border-zinc-900 flex items-center justify-between px-6 bg-zinc-950/70 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center space-x-3">
          <IdentityIcon pubKey={targetPubKey} size={36} />
          <div className="flex flex-col">
            <div className="font-mono text-sm font-medium tracking-tight text-zinc-200">
              {alias || formatPubKey(targetPubKey)}
            </div>
            <div className="text-[10px] text-zinc-500 flex items-center space-x-1 mt-0.5">
              <Lock className="h-3 w-3" />
              <span>E2E Encrypted</span>
            </div>
          </div>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center space-x-2 bg-zinc-900/50 px-3 py-1.5 rounded-full border border-zinc-800 shadow-sm">
          {status === "connecting" && (
            <>
              <div className="w-2 h-2 rounded-full bg-amber-500/50 animate-pulse" />
              <span className="text-xs font-medium text-zinc-400">Connecting...</span>
            </>
          )}
          {status === "online" && (
            <>
              <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse" />
              <span className="text-xs font-medium text-emerald-500">Direct (P2P)</span>
            </>
          )}
          {status === "relay" && (
            <>
              <div className="flex items-center">
                <div className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
                <Zap className="h-3 w-3 text-amber-500 ml-1.5 opacity-80" />
              </div>
              <span className="text-xs font-medium text-amber-500 ml-1.5">Relay (D1)</span>
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="text-center w-full py-8 text-xs text-zinc-600 font-mono flex flex-col items-center justify-center">
          <Shield className="h-8 w-8 mx-auto mb-3 opacity-20 text-zinc-500" />
          <span className="mb-1">Zero-Trust End-to-End Encrypted Session.</span>
          <span>No central server stores your keys.</span>
        </div>
        
        {messages.map((msg: any) => {
          const isMine = msg.senderPubKey === myPub
          return (
            <div key={msg.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm ${
                  isMine
                    ? "bg-zinc-100 text-zinc-900 rounded-br-sm shadow-sm"
                    : "bg-zinc-900 text-zinc-200 rounded-bl-sm border border-zinc-800 shadow-sm"
                }`}
              >
                {msg.content}
              </div>
              <div className="text-[10px] text-zinc-600 mt-1.5 px-1 font-mono">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-zinc-950 border-t border-zinc-900">
        <form onSubmit={handleSend} className="relative flex items-center max-w-4xl mx-auto">
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Encrypt a message..."
            className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm rounded-lg pl-4 pr-12 py-3.5 focus:outline-none focus:ring-1 focus:ring-zinc-700 focus:border-zinc-700 transition-all placeholder:text-zinc-600 shadow-sm"
          />
          <button
            type="submit"
            disabled={!content.trim()}
            className="absolute right-2 p-2 rounded-md bg-zinc-100 text-zinc-900 disabled:opacity-50 disabled:bg-zinc-800 disabled:text-zinc-600 transition-all shrink-0 hover:bg-white active:scale-95 shadow-sm"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  )
}
