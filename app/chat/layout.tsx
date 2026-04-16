"use client"

import Link from "next/link"
import { useState, useEffect } from "react"
import { Shield, Plus } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const [myPub, setMyPub] = useState<string>("")
  const [contacts, setContacts] = useState<{pub: string, alias: string}[]>([])
  const [newContactPub, setNewContactPub] = useState("")
  const [newContactAlias, setNewContactAlias] = useState("")

  useEffect(() => {
    const pub = localStorage.getItem("serotine_identity_public_enc")
    if (pub) setMyPub(pub)
    
    const saved = localStorage.getItem("serotine_contacts_v2")
    if (saved) {
      setContacts(JSON.parse(saved))
    } else {
      // Migrate old string contacts if exist
      const old = localStorage.getItem("serotine_contacts")
      if (old) {
        const parsed = JSON.parse(old)
        const migrated = parsed.map((c: string) => ({ pub: c, alias: '' }))
        setContacts(migrated)
        localStorage.setItem("serotine_contacts_v2", JSON.stringify(migrated))
      }
    }
  }, [])

  const copyMyPubKey = () => {
    if (myPub) {
      navigator.clipboard.writeText(myPub)
      alert("Hex Identity Copied to Clipboard!")
    }
  }

  const addContact = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newContactPub.trim()) return
    const exists = contacts.find(c => c.pub === newContactPub.trim())
    if (exists) return
    
    const updated = [...contacts, { pub: newContactPub.trim(), alias: newContactAlias.trim() }]
    setContacts(updated)
    localStorage.setItem("serotine_contacts_v2", JSON.stringify(updated))
    setNewContactPub("")
    setNewContactAlias("")
  }

  const formatPubKey = (key: string) => {
    if (!key) return ""
    if (key.length <= 10) return key
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }

  return (
    <div className="flex h-screen bg-zinc-950 font-sans tracking-tight text-zinc-300">
      {/* Sidebar */}
      <div className="w-80 border-r border-zinc-900 flex flex-col bg-zinc-950/50 backdrop-blur-md">
        <div className="p-5 border-b border-zinc-900 flex items-center">
          <div className="flex items-center space-x-3 text-zinc-100 cursor-pointer hover:text-zinc-400 transition-colors" onClick={copyMyPubKey} title="Click to copy your Hex ID">
            <Shield className="h-5 w-5" />
            <span className="font-bold font-serif text-lg tracking-wider">Serotine</span>
          </div>
        </div>
        
        <div className="p-4 border-b border-zinc-900">
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">Your Identity</div>
            <button 
              onClick={() => {
                const priv = localStorage.getItem("serotine_identity_private_enc")
                if (priv) {
                  navigator.clipboard.writeText(priv)
                  alert("Private Key Copied! DO NOT SHARE THIS WITH ANYONE.")
                }
              }}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 font-medium transition-colors"
              title="Backup Private Key"
            >
              Export Key
            </button>
          </div>
          <div 
            onClick={copyMyPubKey}
            className="flex items-center space-x-3 cursor-pointer p-2 rounded-lg hover:bg-zinc-900 transition-colors border border-transparent hover:border-zinc-800"
          >
            <IdentityIcon pubKey={myPub || 'default'} size={32} />
            <div className="flex flex-col">
              <span className="text-sm font-medium text-zinc-200">Me (Local)</span>
              <span className="text-xs font-mono text-zinc-500">{formatPubKey(myPub) || "Generating..."}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          <div className="text-[10px] text-zinc-500 mb-2 px-1 uppercase tracking-widest font-semibold">Connections</div>
          
          <form onSubmit={addContact} className="flex flex-col space-y-2 mb-6">
            <input
              type="text"
              placeholder="Hex Address"
              value={newContactPub}
              onChange={e => setNewContactPub(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-zinc-700 text-zinc-200 placeholder:text-zinc-600 shadow-sm"
              required
            />
            <div className="flex space-x-2">
              <input
                type="text"
                placeholder="Alias (Optional)"
                value={newContactAlias}
                onChange={e => setNewContactAlias(e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-zinc-700 text-zinc-200 placeholder:text-zinc-600 shadow-sm"
              />
              <button type="submit" className="bg-zinc-100 text-zinc-900 p-2 rounded-md hover:bg-zinc-200 shadow-sm flex items-center justify-center shrink-0">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </form>

          <div className="space-y-1">
            {contacts.map(c => (
              <Link key={c.pub} href={`/chat/${c.pub}`} className="block">
                <div className="flex items-center space-x-3 p-2 rounded-lg hover:bg-zinc-900 transition-colors border border-transparent hover:border-zinc-800 cursor-pointer">
                  <IdentityIcon pubKey={c.pub} size={32} />
                  <div className="flex flex-col overflow-hidden">
                    <span className="text-sm font-medium text-zinc-200 truncate">{c.alias || formatPubKey(c.pub)}</span>
                    {c.alias && <span className="text-xs font-mono text-zinc-500 truncate">{formatPubKey(c.pub)}</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-zinc-950 relative">
        {children}
      </div>
    </div>
  )
}
