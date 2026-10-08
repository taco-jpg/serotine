import type { Metadata } from "next"
import Link from "next/link"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"
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
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d={diagonal ? "M5 15 15 5M5 5h10v10" : "M4 10h12m-5-5 5 5-5 5"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function Sparkle() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><path d="M16 2.5 19.2 12.8 29.5 16l-10.3 3.2L16 29.5l-3.2-10.3L2.5 16l10.3-3.2L16 2.5Z" fill="currentColor" /><circle cx="25.5" cy="6.5" r="2" fill="currentColor" /></svg>
}

export default function LandingPage() {
  return (
    <div id="serotine-landing" className={styles.landing}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <div className={styles.announcement}><span className={styles.announcementMark} aria-hidden="true" /><span>Private by design. Open about how.</span><a href="#security">See the details <Arrow /></a></div>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Serotine home"><AppLogo /></Link>
        <nav className={styles.nav} aria-label="Main navigation">
          <a href="#features">The essentials</a>
          <a href="#security">Our approach</a>
          <a href={repository} target="_blank" rel="noopener noreferrer">Source <Arrow diagonal /></a>
        </nav>
        <div className={styles.headerActions}><ThemeControl /><Button asChild variant="outline" className={styles.topEntry}><Link prefetch={false} href="/login">Open Serotine <Arrow diagonal /></Link></Button></div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className={styles.story} data-story aria-labelledby="hero-title">
          <div className={styles.camera}>
            <div className={styles.heroGrid}>
              <div className={styles.intro}>
                <p className={styles.kicker}><span className={styles.kickerDot} aria-hidden="true" /> A QUIETER KIND OF MESSAGING</p>
                <h1 id="hero-title">Closer to<br /><em>your people.</em></h1>
                <p className={styles.productContext}>Private messaging for the people you choose. No feed to keep up with, no phone number to hand over.</p>
                <div className={styles.heroActions}>
                  <a className={styles.heroLink} href="#your-conversation">See how it feels <Arrow /></a>
                  <span className={styles.heroMeta}><Sparkle /> Made for the conversations that matter.</span>
                </div>
                <div className={styles.heroProof} aria-label="Serotine at a glance">
                  <div><span>01</span><p>No email<br />or phone</p></div>
                  <div><span>02</span><p>Your identity<br />stays with you</p></div>
                  <div><span>03</span><p>Open source<br />by nature</p></div>
                </div>
              </div>

              <div className={styles.stage} data-stage>
                <span className={styles.sideNote} aria-hidden="true">A place for the words<br />you meant to send.</span>
                <span className={styles.threadTrace} aria-hidden="true" />
                <div className={styles.previewFrame}>
                  <div className={styles.previewTop}><span className={styles.previewBrand}><span aria-hidden="true" /> SEROTINE / PRIVATE THREAD</span><span className={styles.previewLabel}>ILLUSTRATIVE PREVIEW</span></div>
                  <div className={styles.conversation} data-conversation>
                    <div className={styles.contactBar}>
                      <details className={styles.identityDetail} data-identity>
                        <summary><span className={styles.identityMark}><IdentityIcon pubKey={exampleIdentity} size={34} /></span><span className={styles.identityName}>Mara<span className={styles.contactHint}>A name on your side</span></span><span className={styles.identityPlus} aria-hidden="true">+</span></summary>
                        <div className={styles.identityPopover}><p>A name on your side.<br />An address underneath.</p><code>041976a9…76a9ff</code><small>Display-only identity, not a contact you can message.</small></div>
                      </details>
                      <span className={styles.exampleLabel}><span aria-hidden="true" /> A conversation, at its own pace</span>
                    </div>

                    <div className={styles.thread} data-demo-viewport>
                      <div className={styles.exampleMessages} aria-hidden="true">
                        <div className={styles.incoming} data-first-message><span className={styles.sender}>Mara</span><p>Taking the long way home.</p><span className={styles.time}>18:41</span></div>
                        <div className={styles.travellingMessage} data-travelling-message>
                          <div className={styles.messageLayers}><p className={styles.plainMessage}>Tell me when you get there.</p><p className={styles.sealedMessage}>a9 c3 · 7f 2e · b4 08<br />d1 6a · 03 f8 · e2 5c</p><span className={styles.envelopeEdge} /></div>
                          <span className={styles.time}>18:42 <span className={styles.receipt}>✓✓</span></span>
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
                </div>
                <span className={styles.edgeNote} aria-hidden="true"><span className={styles.edgeRule} /><span data-edge-copy>A thought, on its way.</span></span>
              </div>
            </div>

            <div className={styles.storyFooter}>
              <a href="#features" className={styles.scrollInvitation}>Scroll to find your kind of quiet <span aria-hidden="true">↓</span></a>
              <div className={styles.storySteps} aria-hidden="true"><span /><span /><span /></div>
              <label className={styles.motionControl}><input type="checkbox" data-still /> Still view</label>
            </div>
          </div>
        </section>

        <section id="features" className={styles.featureSection} aria-labelledby="features-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}><span className={styles.kickerDot} aria-hidden="true" /> THE ESSENTIALS</p>
            <h2 id="features-title">More conversation.<br /><em>Less everything else.</em></h2>
            <p>All the useful parts of staying close. None of the pressure to perform.</p>
          </div>
          <div className={styles.featureGrid}>
            <article className={styles.featureCard}>
              <span className={styles.featureNumber}>01 <span>IDENTITY</span></span>
              <div className={styles.featureGlyph}><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 3.5 26 7v7.3c0 6.5-4.2 11.7-10 14.2C10.2 26 6 20.8 6 14.3V7l10-3.5Z" stroke="currentColor" strokeWidth="1.6" /><path d="M11.5 16.4 14.5 19l6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
              <h3>An identity, not an account.</h3>
              <p>Create a cryptographic identity on your device. No email address, phone number, or password to remember.</p>
              <span className={styles.featureFoot}>YOUR KEYS · YOUR DEVICE</span>
            </article>
            <article className={styles.featureCard}>
              <span className={styles.featureNumber}>02 <span>CONVERSATION</span></span>
              <div className={styles.featureGlyph}><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 7.5h22v15H15l-6.5 5v-5H5v-15Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M10 13h12M10 17h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
              <h3>Keep the thread yours.</h3>
              <p>Talk one to one, make a group, share a file, or leave a note for yourself. Your inbox is yours to shape.</p>
              <span className={styles.featureFoot}>DIRECT · GROUPS · FILES</span>
            </article>
            <article className={styles.featureCard}>
              <span className={styles.featureNumber}>03 <span>TRANSPARENCY</span></span>
              <div className={styles.featureGlyph}><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.6" /><path d="M5.8 16h20.4M16 5c3 3 4.5 6.7 4.5 11S19 24 16 27M16 5c-3 3-4.5 6.7-4.5 11S13 24 16 27" stroke="currentColor" strokeWidth="1.6" /></svg></div>
              <h3>Open by default.</h3>
              <p>Serotine is open source. Read how it works, understand its limits, and decide whether it feels right for you.</p>
              <a className={styles.featureLink} href={repository} target="_blank" rel="noopener noreferrer">Explore the source <Arrow diagonal /></a>
            </article>
          </div>
        </section>

        <section id="security" className={styles.securitySection} aria-labelledby="security-title">
          <div className={styles.securityCopy}>
            <p className={styles.kicker}><span className={styles.kickerDot} aria-hidden="true" /> CLEAR-EYED PRIVACY</p>
            <h2 id="security-title">Privacy should be<br /><em>plain-spoken.</em></h2>
            <p>Messages are encrypted on your device before delivery. We think that matters. We also think you should know what the current design does not promise.</p>
            <a className={styles.securityLink} href={`${repository}#readme`} target="_blank" rel="noopener noreferrer">Read the implementation and limits <Arrow diagonal /></a>
          </div>
          <div className={styles.securityLedger} aria-label="Privacy details">
            <div><span className={styles.ledgerNumber}>01</span><span><strong>On-device identity</strong><small>Your address is created in this browser.</small></span><span className={styles.ledgerMark}>LOCAL</span></div>
            <div><span className={styles.ledgerNumber}>02</span><span><strong>Encrypted messages</strong><small>Payloads are encrypted before relay storage.</small></span><span className={styles.ledgerMark}>E2E</span></div>
            <div><span className={styles.ledgerNumber}>03</span><span><strong>Known limitations</strong><small>No independent audit or forward secrecy yet.</small></span><span className={styles.ledgerMark}>READ</span></div>
          </div>
        </section>

        <section id="your-conversation" className={styles.continuation} data-continuation aria-labelledby="continuation-title">
          <div className={styles.continuationCopy}><p className={styles.kicker}><span className={styles.kickerDot} aria-hidden="true" /> WHEN YOU'RE READY</p><h2 id="continuation-title">A little more room<br /><em>for your people.</em></h2><p>Start with a conversation. Keep what matters close.</p></div>
          <div className={styles.echo}>
            <span className={styles.echoLine} aria-hidden="true" />
            <div className={styles.echoNote}><span className={styles.sender}>A note from the preview</span><p data-echo>“I thought you’d like this.”</p><span className={styles.echoCaption} data-echo-caption>It can start with something small.</span></div>
          </div>
          <div className={styles.invitation}><Button asChild size="lg" className={styles.primaryEntry}><Link prefetch={false} href="/login">Start your conversation <Arrow /></Link></Button><p className={styles.entryNote}>An identity on your device.<br />No email address or phone number.</p></div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}><Link href="/" className={styles.footerBrand}>serotine<span>.</span></Link><a href={repository} target="_blank" rel="noopener noreferrer">Open source <Arrow diagonal /></a></div>
        <div className={styles.footerBottom}>
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
          <p className={styles.footerStamp}>A little closer, at your own pace.</p>
        </div>
      </footer>
      <LandingEnhancements />
    </div>
  )
}
