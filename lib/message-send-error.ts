/** Lets the composer keep text when neither local history nor the relay has it. */
export class MessageSendError extends Error {
  constructor(message: string, readonly savedLocally: boolean) {
    super(message)
    this.name = "MessageSendError"
  }
}
