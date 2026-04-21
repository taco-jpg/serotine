import type React from "react"
import Link from "next/link"
import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import { Shield, Lock, EyeOff, Zap } from "lucide-react"

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden py-24 md:py-32 lg:py-40">
          <div className="container px-4 md:px-6">
            <div className="flex flex-col items-center space-y-8 text-center">
              <div className="space-y-4">
                <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl lg:text-7xl font-serif bg-clip-text text-transparent bg-gradient-to-b from-foreground to-foreground/70">
                  Contact without a <span className="text-primary">central server</span>
                </h1>
                <p className="mx-auto max-w-[700px] text-muted-foreground md:text-xl leading-relaxed">
                  Experience true privacy with Serotine. End-to-end encrypted messaging that disappears when you want it
                  to. No logs. No traces.
                </p>
              </div>
              <div className="flex flex-col gap-4 min-[400px]:flex-row">
                <Link href="/login?view=signup">
                  <Button size="lg" className="h-12 px-8 text-lg bg-primary hover:bg-primary/90">
                    Establish Connection
                  </Button>
                </Link>
                <Link href="/about">
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-12 px-8 text-lg border-primary/20 hover:bg-primary/10 hover:text-primary bg-transparent"
                  >
                    Learn More
                  </Button>
                </Link>
              </div>
            </div>
          </div>

          {/* Decorative background elements */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl -z-10" />
        </section>

        <section className="container px-4 py-12 md:py-24 lg:py-32">
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={<Shield className="h-10 w-10 text-primary" />}
              title="End-to-End Encrypted"
              description="Your messages are encrypted on your device and can only be read by the recipient."
            />
            <FeatureCard
              icon={<EyeOff className="h-10 w-10 text-primary" />}
              title="Zero Knowledge"
              description="We don't know who you are, who you talk to, or what you say. We can't see your data."
            />
            <FeatureCard
              icon={<Zap className="h-10 w-10 text-primary" />}
              title="Self-Destructing"
              description="Set messages to vanish automatically after they are read. Leave no trace behind."
            />
            <FeatureCard
              icon={<Lock className="h-10 w-10 text-primary" />}
              title="Anonymous Identity"
              description="Sign up without a phone number or email. Your identity is yours to protect."
            />
          </div>
        </section>
      </main>
      <footer className="border-t border-border/40 py-6 md:py-0">
        <div className="container flex flex-col items-center justify-between gap-4 md:h-24 md:flex-row">
          <p className="text-center text-sm leading-loose text-muted-foreground md:text-left">
            © 2025 Serotine. Built for the shadows. 💬
          </p>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center space-y-4 text-center p-6 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 transition-colors">
      <div className="p-3 rounded-full bg-primary/10 ring-1 ring-primary/20">{icon}</div>
      <h3 className="text-xl font-bold font-serif">{title}</h3>
      <p className="text-muted-foreground">{description}</p>
    </div>
  )
}
