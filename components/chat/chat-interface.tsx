'use client'

import { useState, useEffect, useRef } from 'react'
import { useWebRTC, Message } from '@/hooks/use-webrtc'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Send, Users, Wifi, WifiOff, Lock } from 'lucide-react'
import { cn } from "@/lib/utils"

interface ChatInterfaceProps {
  roomId: string
  userId: string
  userName?: string
}

export function ChatInterface({ roomId, userId, userName = 'Anonymous' }: ChatInterfaceProps) {
  const { messages, peers, isConnected, sendMessage } = useWebRTC(roomId, userId)
  const [inputValue, setInputValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputValue.trim()) return
    
    sendMessage(inputValue)
    setInputValue('')
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg border border-border/50 bg-card/50 p-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-serif">Secure Channel</h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                {isConnected ? (
                  <Wifi className="h-3 w-3 text-green-500" />
                ) : (
                  <WifiOff className="h-3 w-3 text-destructive" />
                )}
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {peers.length} Peer{peers.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
        <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
          P2P Encrypted
        </Badge>
      </div>

      <Card className="flex-1 overflow-hidden border-border/50 bg-card/30 backdrop-blur-sm">
        <CardContent className="p-0 h-full flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center space-y-4 py-20 text-center text-muted-foreground opacity-50">
                  <Lock className="h-12 w-12" />
                  <p>No messages yet. Start the conversation securely.</p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMe = msg.senderId === userId
                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        "flex w-full gap-2",
                        isMe ? "justify-end" : "justify-start"
                      )}
                    >
                      {!isMe && (
                        <Avatar className="h-8 w-8 border border-border/50">
                          <AvatarFallback className="bg-secondary text-xs">
                            {msg.senderId.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <div
                        className={cn(
                          "max-w-[70%] rounded-2xl px-4 py-2 text-sm shadow-sm",
                          isMe
                            ? "bg-primary text-primary-foreground rounded-br-none"
                            : "bg-card border border-border/50 rounded-bl-none"
                        )}
                      >
                        <p>{msg.content}</p>
                        <span className="mt-1 block text-[10px] opacity-50">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
          
          <div className="border-t border-border/50 p-4 bg-card/50">
            <form onSubmit={handleSend} className="flex gap-2">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Type an encrypted message..."
                className="bg-background/50 border-primary/20 focus-visible:ring-primary"
                disabled={!isConnected}
              />
              <Button 
                type="submit" 
                size="icon" 
                disabled={!isConnected || !inputValue.trim()}
                className="bg-primary hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
