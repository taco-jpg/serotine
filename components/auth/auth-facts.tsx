"use client"

import * as React from "react"
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/components/ui/carousel"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const facts = [
  {
    title: "P2P History",
    description:
      "Peer-to-peer (P2P) computing became popularized by file-sharing systems like Napster in 1999, but the concept dates back to the original ARPANET in 1969, where every node could communicate with every other node as an equal.",
  },
  {
    title: "IP Ports",
    description:
      "Think of an IP address as a building's street address, and the Port number as the specific apartment number. There are 65,535 possible ports for a single IP address!",
  },
  {
    title: "Decryption",
    description:
      "Decryption is the process of transforming data that has been rendered unreadable through encryption back to its unencrypted form. In WWII, the Enigma machine's code was cracked not just by math, but by finding repeated phrases like weather reports.",
  },
  {
    title: "Password History",
    description:
      "The first computer password was introduced in 1961 at MIT on the CTSS system. It was created to allow multiple users to share the same computer while keeping their files private.",
  },
  {
    title: "Did You Know?",
    description:
      "The first spam email was sent in 1978 over ARPANET to 393 recipients. It was an advertisement for a new model of DEC computers.",
  },
]

export function AuthFacts({ className }: { className?: string }) {
  const [api, setApi] = React.useState<CarouselApi>()

  React.useEffect(() => {
    if (!api) return

    const interval = setInterval(() => {
      api.scrollNext()
    }, 6000)

    return () => clearInterval(interval)
  }, [api])

  return (
    <div className={cn("flex flex-col justify-center", className)}>
      <Carousel setApi={setApi} className="w-full max-w-md mx-auto" opts={{ loop: true }}>
        <CarouselContent>
          {facts.map((fact, index) => (
            <CarouselItem key={index}>
              <div className="p-1">
                <Card className="bg-transparent border-none shadow-none">
                  <CardContent className="flex flex-col items-center text-center p-6 space-y-4">
                    <h3 className="text-2xl font-bold tracking-tight text-foreground">{fact.title}</h3>
                    <p className="text-muted-foreground text-lg leading-relaxed">{fact.description}</p>
                  </CardContent>
                </Card>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
    </div>
  )
}
