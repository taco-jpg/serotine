import { Suspense } from "react"
import Link from "next/link"
import { Shield } from "lucide-react"
import { LoginForm } from "@/components/auth/login-form"

export default function LoginPage() {
  return (
    <div className="min-h-screen w-full bg-zinc-950 text-zinc-100 selection:bg-zinc-800 font-sans tracking-tight flex flex-col pt-12 items-center">
      {/* Top Logo */}
      <Link href="/" className="flex items-center space-x-2 text-zinc-100 hover:text-zinc-300 transition-colors mb-12">
        <Shield className="h-6 w-6" />
        <span className="font-bold font-serif text-2xl tracking-wider">Serotine</span>
      </Link>

      <div className="w-full max-w-[440px] px-6">
        <div className="border border-zinc-800 bg-zinc-900/50 backdrop-blur-md rounded-xl p-8 shadow-2xl relative overflow-hidden">
          {/* Subtle noise or gradient bg could go here, but keeping Linear/Vercel pure black style */}
          <div className="space-y-2 mb-8 text-center">
            <h1 className="text-2xl font-medium tracking-tight text-zinc-100">Welcome to Serotine</h1>
            <p className="text-sm text-zinc-400">Generate your local identity to enter the network</p>
          </div>
          
          <Suspense fallback={<div className="h-20 animate-pulse bg-zinc-800/50 rounded-md" />}>
             {/* The dark LoginForm button will appear here */}
            <LoginForm />
          </Suspense>
        </div>
      </div>

      {/* Cryptography Lab / Education Features */}
      <section className="mt-24 w-full max-w-5xl px-6 grid grid-cols-1 md:grid-cols-3 gap-6 text-sm text-zinc-400 pb-20">
        <div className="p-6 border border-zinc-800 bg-zinc-900/30 rounded-xl shadow-sm hover:bg-zinc-900/50 transition-colors">
          <h3 className="text-zinc-200 font-semibold mb-2 tracking-tight text-base">Key Exchange (ECDH)</h3>
          <p className="leading-relaxed">
            We don't store passwords. Your identity is a cryptographic key pair generated locally via Web Crypto API. A shared secret secures data point-to-point.
          </p>
        </div>
        
        <div className="p-6 border border-zinc-800 bg-zinc-900/30 rounded-xl shadow-sm hover:bg-zinc-900/50 transition-colors">
          <h3 className="text-zinc-200 font-semibold mb-2 tracking-tight text-base">P2P Routing (WebRTC)</h3>
          <p className="leading-relaxed">
            Messages travel directly from your device to the recipient's via secure DataChannels. Bypassing central servers limits mass metadata collection.
          </p>
        </div>
        
        <div className="p-6 border border-zinc-800 bg-zinc-900/30 rounded-xl shadow-sm hover:bg-zinc-900/50 transition-colors">
          <h3 className="text-zinc-200 font-semibold mb-2 tracking-tight text-base">Offline Relay (D1)</h3>
          <p className="leading-relaxed">
            If a peer is unreachable, the offline message is encrypted and relayed via Cloudflare D1. Upon collection, it is immediately subjected to physical deletion.
          </p>
        </div>
      </section>
    </div>
  )
}
