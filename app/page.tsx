import type { Metadata } from "next"
import Link from "next/link"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { LandingEnhancements, ThemeControl } from "./landing-controls"
import styles from "./landing.module.css"

const repository = "https://github.com/taco-jpg/serotine"
// A display-only fixture, never imported into the application's identity store.
const exampleIdentity = "04" + "1976a9ff".repeat(16)

export const metadata: Metadata = {
  title: "Serotine — A little closer.",
  description: "A considered place for conversation. Discover Serotine, an open-source messaging app with an identity you create on your own device.",
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
        <div className={styles.headerActions}>
          <ThemeControl />
          <Link href="/login" className={styles.entry}>Open app <Arrow diagonal /></Link>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="hero-title">
          <p className={styles.kicker}>A place for conversation</p>
          <h1 id="hero-title">A little <em>closer.</em></h1>
          <div className={styles.introAside}><p>For a passing thought.<br />Or the one you keep coming back to.</p></div>
          <a className={styles.scrollInvitation} href="#conversation">Take your time <span aria-hidden="true">↓</span></a>
        </section>

        <section id="conversation" className={styles.story} aria-labelledby="conversation-title" data-story>
          <div className={styles.camera}>
            <div className={styles.storyHeading}>
              <h2 id="conversation-title">An ordinary message.</h2>
              <label className={styles.motionControl}><input type="checkbox" data-still /> Still view</label>
            </div>
            <figure className={styles.study}>
              <div className={styles.conversation} data-conversation-art aria-hidden="true">
                <div className={styles.conversationHeader}>
                  <span className={styles.identityMark}><IdentityIcon pubKey={exampleIdentity} size={28} /></span>
                  <span>Mara<span className={styles.exampleLabel}>An example conversation</span></span>
                  <span className={styles.headerEllipsis}>···</span>
                </div>
                <div className={styles.messageSpace}>
                  <div className={styles.beforeMessage}><span className={styles.sender}>Mara</span><p>Taking the long way home.</p></div>
                  <div className={styles.travellingMessage}>
                    <p className={styles.plainMessage}>Tell me when you get there.</p>
                    <p className={styles.sealedMessage}>a9 c3 · 7f 2e · b4 08<br />d1 6a · 03 f8 · e2 5c</p>
                    <span className={styles.messageTime}>18:42 <span className={styles.receipt}>✓</span></span>
                  </div>
                  <div className={styles.afterMessage}><span className={styles.sender}>Mara</span><p>Just made it. I’ll tell you about it.</p></div>
                </div>
                <div className={styles.composerFragment}><span>Message Mara</span><Arrow /></div>
              </div>
              <figcaption className={styles.caption}>
                <span>A familiar feeling. A little more room.</span>
                <span className={styles.exampleNote}>Illustrative conversation, not a live exchange.</span>
              </figcaption>
            </figure>
            <div className={styles.storyMargin} aria-hidden="true"><span className={styles.marginStart}>Words, on your side.</span><span className={styles.marginBetween}>A moment between.</span><span className={styles.marginEnd}>Words, on theirs.</span></div>
            <p className={styles.srOnly}>An example message becomes an unreadable representation between two sides, then becomes readable in a conversation again. This is an illustration, not actual encryption.</p>
          </div>
        </section>

        <section className={styles.roomSection} aria-labelledby="room-heading">
          <div className={styles.roomLead}><p className={styles.kicker}>Nothing to perform.</p><h2 id="room-heading">Just something<br /> to <em>say.</em></h2></div>
          <div className={styles.roomBody}>
            <p className={styles.roomAside}>The conversation is the point.<br />Everything else can wait.</p>
            <details className={styles.room} data-room>
              <summary><span>Leave a note</span><span className={styles.roomArrow} aria-hidden="true">↗</span></summary>
              <div className={styles.roomInside}>
                <div className={styles.roomHeader}><span>A quiet room</span><span className={styles.localLabel}>Local demo</span></div>
                <p id="demo-disclosure" className={styles.demoDisclosure}>Scripted replies, not a person or AI. Nothing is sent or saved. Closing this room clears it.</p>
                <div className={styles.demoViewport} data-demo-viewport>
                  <p className={styles.greeting}>You found a little room. Say hello, or leave a thought.</p>
                  <div role="log" aria-label="Demo conversation" aria-live="polite" aria-relevant="additions" tabIndex={0} data-demo-log />
                </div>
                <form data-demo-form aria-label="Write a demo note" aria-describedby="demo-disclosure">
                  <fieldset disabled data-demo-fields className={styles.demoFields}>
                    <legend className={styles.srOnly}>Your note</legend>
                    <label htmlFor="demo-note" className={styles.srOnly}>Your note</label>
                    <div className={styles.demoComposer}><textarea id="demo-note" name="note" rows={2} maxLength={280} placeholder="Something on your mind?" autoComplete="off" spellCheck aria-describedby="demo-help" /><button type="submit" aria-label="Send demo note"><Arrow /></button></div>
                    <div className={styles.demoFooter}><span id="demo-help">Enter to send · Shift + Enter for a new line</span><button type="button" data-demo-reset>Start again</button></div>
                  </fieldset>
                  <p className={styles.demoStatus} data-demo-status role="status" />
                </form>
                <noscript><p className={styles.demoDisclosure}>This little demo needs JavaScript. The app link and the rest of this page still work.</p></noscript>
              </div>
            </details>
            <details className={styles.identityDetail}>
              <summary><span className={styles.identityMark}><IdentityIcon pubKey={exampleIdentity} size={22} /></span><span>Mara</span><span className={styles.identityHint}>a name, and a little more</span><span aria-hidden="true">+</span></summary>
              <div><p>A familiar name on your side. An address underneath.</p><code>041976a9…76a9ff</code><small>Display-only identity, not a contact you can message.</small></div>
            </details>
          </div>
        </section>

        <section className={styles.departure} aria-labelledby="departure-title">
          <span className={styles.departureLine} aria-hidden="true" />
          <p className={styles.kicker}>A thought. A friend. A place to begin.</p>
          <h2 id="departure-title">The rest is<br /><em>your conversation.</em></h2>
          <Link href="/login" className={styles.primaryEntry}>Open Serotine <Arrow /></Link>
          <p className={styles.entryNote}>Create an identity on your device.<br />No email address or phone number.</p>
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
        <details className={styles.marginNote}>
          <summary>A margin note <span aria-hidden="true">↗</span></summary>
          <p><span>1976</span> · <a href="https://doi.org/10.1109/TIT.1976.1055638" target="_blank" rel="noopener noreferrer"><cite>New Directions in Cryptography</cite></a>. Whitfield Diffie and Martin Hellman.</p>
        </details>
      </footer>
      <LandingEnhancements />
    </div>
  )
}
