import { Suspense } from "react"
import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { LoginForm } from "@/components/auth/login-form"
import { ModeToggle } from "@/components/mode-toggle"
import { AuthFacts } from "@/components/auth/auth-facts"

export default function LoginPage() {
  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2">
      <div className="flex flex-col items-center justify-center bg-background p-4 relative order-1 lg:order-2">
        <div className="absolute top-4 right-4">
          <ModeToggle />
        </div>
        <Link href="/" className="mb-8 lg:hidden">
          <AppLogo className="scale-150" />
        </Link>

        <Card className="w-full max-w-md border-border/50 bg-card/50 backdrop-blur-xl">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-serif">Welcome Back</CardTitle>
            <CardDescription>Enter your credentials to access the network</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Suspense fallback={<div>Loading form...</div>}>
              <LoginForm />
            </Suspense>
          </CardContent>
          <CardFooter className="flex flex-col space-y-2 text-center text-sm text-muted-foreground">
            <div>
              Don't have an account?{" "}
              <Link href="/login?view=signup" className="text-primary hover:underline">
                Sign up
              </Link>
            </div>
          </CardFooter>
        </Card>

        {/* Mobile Facts */}
        <div className="mt-8 w-full max-w-md lg:hidden">
          <AuthFacts />
        </div>
      </div>

      {/* Desktop Facts Side */}
      <div className="hidden lg:flex flex-col items-center justify-center bg-muted/30 p-8 order-2 lg:order-1 border-r border-border/50 relative overflow-hidden">
        <div className="absolute top-8 left-8">
          <Link href="/">
            <AppLogo className="scale-150" />
          </Link>
        </div>
        <AuthFacts />
      </div>
    </div>
  )
}
