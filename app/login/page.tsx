import Link from "next/link"
import { ArrowLeft, Shield } from "lucide-react"
import { LoginForm } from "@/components/auth/login-form"

export default function LoginPage() {
  return <main className="min-h-dvh px-5 py-8 sm:py-14">
    <div className="mx-auto max-w-5xl"><Link href="/" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="size-4" /> Back to Serotine</Link></div>
    <div className="mx-auto mt-12 max-w-md sm:mt-20">
      <div className="mb-8 flex items-center gap-3"><div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3"><Shield className="size-6 text-indigo-300" /></div><span className="font-serif text-2xl">Serotine</span></div>
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-2xl sm:p-8">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-indigo-300">Your device. Your identity.</p>
        <h1 className="mb-6 text-3xl">A private place to talk.</h1>
        <LoginForm />
      </div>
      <p className="mt-6 text-center text-sm leading-relaxed text-zinc-500">Your private key stays in this browser. Only share your public contact address.</p>
    </div>
  </main>
}
