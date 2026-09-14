import type { Metadata } from "next"
import Link from "next/link"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { LandingEnhancements, ThemeControl } from "./landing-controls"
import styles from "./landing.module.css"

const repository = "https://github.com/taco-jpg/serotine"
// Display only: this fixture never enters an account, contact, or identity store.
const exampleIdentity = "04" + "1976a9ff".repeat(16)

export const metadata: Metadata = {
  title: "Serotine — A little closer.",
  description: "Private messaging for the people you choose. A considered place for conversation, with an identity you create on your own device.",
}

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d={diagonal ? "M5 15 15 5M5 5h10v10" : "M4 10h12m-5-5 5 5-5 5"} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export default function LandingPage() {
  return (
    <div id="serotine-landing" className={styles.landing}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Serotine home">serotine<span aria-hidden="true">.</span></Link>
        <div className={styles.headerActions}><ThemeControl /><Link prefetch={false} href="/login" className={styles.entry}>Open app <Arrow diagonal /></Link></div>
      </header>
      <main id="main" tabIndex={-1}>
        <section className={styles.story} data-story aria-labelledby="hero-title">
          <div className={styles.camera}>
            <div className={styles.intro}>
              <p className={styles.kicker}>A place for conversation</p>
              <h1 id="hero-title">A little <em>closer.</em></h1>
              <p className={styles.productContext}>Private messaging for the people you choose.</p>
            </div>

            <div className={styles.stage} data-stage>
              <span className={styles.sideNote} aria-hidden="true">The little things,<br />worth sending.</span>
              <span className={styles.threadTrace} aria-hidden="true" />
              <div className={styles.conversation} data-conversation>
                <div className={styles.contactBar}>
                  <details className={styles.identityDetail} data-identity>
                    <summary><span className={styles.identityMark}><IdentityIcon pubKey={exampleIdentity} size={28} /></span><span>Mara<span className={styles.contactHint}>a familiar name</span></span><span className={styles.identityPlus} aria-hidden="true">+</span></summary>
                    <div className={styles.identityPopover}><p>A name on your side.<br />An address underneath.</p><code>041976a9…76a9ff</code><small>Display-only identity, not a contact you can message.</small></div>
                  </details>
                  <span className={styles.exampleLabel}>Example conversation</span>
                </div>

                <div className={styles.thread} data-demo-viewport>
                  <div className={styles.exampleMessages} aria-hidden="true">
                    <div className={styles.incoming} data-first-message><span className={styles.sender}>Mara</span><p>Taking the long way home.</p><span className={styles.time}>18:41</span></div>
                    <div className={styles.travellingMessage} data-travelling-message>
                      <div className={styles.messageLayers}><p className={styles.plainMessage}>Tell me when you get there.</p><p className={styles.sealedMessage}>a9 c3 · 7f 2e · b4 08<br />d1 6a · 03 f8 · e2 5c</p><span className={styles.envelopeEdge} /></div>
                      <span className={styles.time}>18:42 <span className={styles.receipt}>✓</span></span>
                    </div>
                    <div className={styles.arrivingMessage} data-arriving-message><span className={styles.sender}>Mara</span><p>Made it. You would’ve loved the sky.</p><span className={styles.time}>18:46</span></div>
                  </div>
                  <p className={styles.srOnly}>Illustrative conversation. Mara: Taking the long way home. You: Tell me when you get there. Mara: Made it. You would’ve loved the sky. Scrolling changes the message’s visual representation; it is not actual encryption.</p>
                  <div className={styles.demoLog} role="log" aria-label="Demo conversation" aria-live="polite" aria-relevant="additions" tabIndex={0} data-demo-log />
                </div>

                <details className={styles.room} data-room>
                  <summary><span className={styles.composerPrompt}><span className={styles.idlePrompt}>Write something back</span><span className={styles.closePrompt}>Close this little conversation</span></span><span className={styles.composerArrow}><Arrow /></span></summary>
                  <div className={styles.roomInside}>
                    <p id="demo-disclosure" className={styles.demoDisclosure}>Local demo · Scripted replies, not a person or AI. Nothing is sent or saved. Closing clears your notes.</p>
                    <form data-demo-form aria-label="Write a demo note" aria-describedby="demo-disclosure">
                      <fieldset disabled data-demo-fields className={styles.demoFields}>
                        <legend className={styles.srOnly}>Your note</legend>
                        <label htmlFor="demo-note" className={styles.srOnly}>Your note</label>
                        <div className={styles.demoComposer}><textarea id="demo-note" name="note" rows={1} maxLength={280} placeholder="Something on your mind?" autoComplete="off" spellCheck aria-describedby="demo-help" /><button type="submit" aria-label="Send demo note"><Arrow /></button></div>
                        <div className={styles.demoFooter}><span id="demo-help">Enter to send · Shift + Enter for a new line</span><button type="button" data-demo-reset>Start again</button></div>
                      </fieldset>
                      <p className={styles.demoStatus} data-demo-status role="status" />
                    </form>
                    <noscript><p className={styles.demoDisclosure}>The local demo needs JavaScript. The conversation, disclosures, and app links still work.</p></noscript>
                  </div>
                </details>
              </div>
              <span className={styles.edgeNote} aria-hidden="true"><span className={styles.edgeRule} /><span data-edge-copy>A thought, on its way.</span></span>
            </div>

            <div className={styles.storyFooter}>
              <a href="#your-conversation" className={styles.scrollInvitation}>Follow the conversation <span aria-hidden="true">↓</span></a>
              <div className={styles.storySteps} aria-hidden="true"><span /><span /><span /></div>
              <label className={styles.motionControl}><input type="checkbox" data-still /> Still view</label>
            </div>
          </div>
        </section>

        <section id="your-conversation" className={styles.continuation} data-continuation aria-labelledby="continuation-title">
          <div className={styles.continuationCopy}><p className={styles.kicker}>From an ordinary moment</p><h2 id="continuation-title">To a conversation<br /><em>only you could have.</em></h2></div>
          <div className={styles.echo}>
            <span className={styles.echoLine} aria-hidden="true" />
            <div className={styles.echoNote}><span className={styles.sender}>You</span><p data-echo>“I thought you’d like this.”</p><span className={styles.echoCaption} data-echo-caption>It can start with something small.</span></div>
          </div>
          <div className={styles.invitation}><Link prefetch={false} href="/login" className={styles.primaryEntry}>Start your conversation <Arrow /></Link><p className={styles.entryNote}>An identity on your device.<br />No email address or phone number.</p></div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerTop}><a href="#serotine-landing" className={styles.footerBrand}>serotine.</a><a href={repository} target="_blank" rel="noopener noreferrer">Open source <Arrow diagonal /></a></div>
        <details className={styles.finePrint}>
          <summary>A few things to know <span aria-hidden="true">+</span></summary>
          <div className={styles.finePrintBody}>
            <p>Serotine has not undergone an independent security audit. The current protocol does not provide forward secrecy. A compromised device can expose messages and keys.</p>
            <p>The relay can see routing addresses and timing, and keeps encrypted payloads for up to seven days. Deleting a message does not erase a recipient’s copy.</p>
            <p>The conversation above is illustrative; no real message or key is created. The local demo uses fixed rules, not encryption or a network connection. It does not demonstrate the security of the real app.</p>
            <a href={`${repository}#readme`} target="_blank" rel="noopener noreferrer">Read the implementation and its limits <Arrow diagonal /></a>
          </div>
        </details>
        <details className={styles.marginNote}><summary>A margin note <span aria-hidden="true">↗</span></summary><p><span>1976</span> · <a href="https://doi.org/10.1109/TIT.1976.1055638" target="_blank" rel="noopener noreferrer"><cite>New Directions in Cryptography</cite></a>. Whitfield Diffie and Martin Hellman.</p></details>
      </footer>
      <LandingEnhancements />
    </div>
  )
}
