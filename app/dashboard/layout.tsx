import { DashboardNav } from "@/components/dashboard/nav"
import { DeviceChecker } from "@/components/dashboard/device-checker"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <DeviceChecker>
      <div className="flex h-screen overflow-hidden bg-background selection:bg-primary/30">
        <aside className="hidden w-64 flex-col md:flex border-r border-border/40 bg-card/20 backdrop-blur-xl">
          <DashboardNav />
        </aside>
        <main className="flex-1 overflow-y-auto relative">
          {/* Ambient background glow */}
          <div className="fixed top-0 left-0 w-full h-full pointer-events-none z-0">
            <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-primary/5 rounded-full blur-[100px]" />
            <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-accent/5 rounded-full blur-[100px]" />
          </div>
          
          <div className="relative z-10">
            {children}
          </div>
        </main>
      </div>
    </DeviceChecker>
  )
}
