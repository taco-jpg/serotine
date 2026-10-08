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
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d={diagonal ? "M5 15 15 5M5 5h10v10" : "M4 10h12m-5-5 5 5-5 5"} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

const tickerItems = [
  "Device-local identity",
  "ECDH · P-256",
  "AES-GCM payloads",
  "ECDSA signed events",
  "No phone number",
  "No email address",
  "4 MiB encrypted chunks",
  "Open source",
]

const metrics = [
  { value: "None", label: "Email or phone required" },
  { value: "7 days", label: "Relay retention, encrypted" },
  { value: "1 GiB", label: "Maximum file size" },
  { value: "20", label: "People per group" },
]

const capabilities = [
  { index: "01", title: "Device-local identity", body: "Generate a key pair in this browser. There is no account, no recovery email, and no phone number attached to you." },
  { index: "02", title: "Sealed end-to-end", body: "ECDH P-256 agreement, AES-GCM payloads, and ECDSA-signed events. The relay forwards ciphertext it cannot read." },
  { index: "03", title: "Files up to 1 GiB", body: "Encrypted in bounded 4 MiB parts and authenticated before they open or download." },
  { index: "04", title: "Groups and communities", body: "Up to twenty people, eight channels, and invitations that expire in seven days." },
  { index: "05", title: "Direct voice and video", body: "WebRTC media with STUN routing and a signed signal over WSS." },
  { index: "06", title: "Backups you hold", body: "A password-encrypted export of your identity, history, and preferences." },
]

const pillars = [
  "An account is a record somebody else keeps. A key pair is yours. Serotine starts there: the identity is created on your device, and the address you share is derived from it.",
  "The relay exists to move bytes, not to hold a conversation. It sees routing addresses and timing, and keeps encrypted payloads for up to seven days.",
  "Deleting something here means deleting it from this device. Recipients keep their own copies, and no control on your side reaches them.",
  "The implementation is public and unaudited. Reading it is the only way to check the claims on this page.",
]

const specifications = [
  { term: "Key agreement", value: "ECDH · P-256" },
  { term: "Message payload", value: "AES-GCM" },
  { term: "Event signature", value: "ECDSA · P-256 · SHA-256" },
  { term: "Relay retention", value: "7 days, encrypted" },
  { term: "Forward secrecy", value: "Not provided" },
]

const faqs = [
  {
    question: "What does Serotine need from me to start?",
    answer: "Nothing but a browser. An identity is a key pair generated on your device; there is no sign-up, no email address, and no phone number. If you want the same identity on another device, use a password-encrypted backup.",
  },
  {
    question: "Who can read my messages?",
    answer: "Only the participants, on devices that hold the matching keys. Messages are sealed before they leave your browser and the relay stores ciphertext. The relay can still see which addresses are talking and when.",
  },
  {
    question: "What happens if I delete a message?",
    answer: "It is removed from this device's saved history, search, pins, and shared-file list. Other participants and independently linked devices keep their copies, and deletion cannot recall something already delivered.",
  },
  {
    question: "Has Serotine been audited?",
    answer: "No. Serotine has not undergone an independent security audit, and the current protocol does not provide forward secrecy. A compromised device can expose messages and keys. Treat it as unaudited software.",
  },
  {
    question: "Can I use it on a phone?",
    answer: "Yes in the browser: the inbox, conversation view, dialogs, and composer all adapt to narrow screens and the on-screen keyboard. Bundled native clients are built from the same source but are still pending platform qualification.",
  },
]

export default function LandingPage() {
  return (
    <div id="serotine-landing" className={styles.landing}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Serotine home"><AppLogo /></Link>
        <nav aria-label="Landing sections" className={styles.nav}>
          <a href="#capabilities">Product</a>
          <a href="#encryption">Encryption</a>
          <a href="#faq">FAQ</a>
          <a href={repository} target="_blank" rel="noopener noreferrer">Source</a>
        </nav>
        <div className={styles.headerActions}>
          <ThemeControl />
          <Button asChild className={styles.entry}>
            <Link prefetch={false} href="/login">Open app <Arrow diagonal /></Link>
          </Button>
        </div>
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
                    <summary><span className={styles.identityMark}><IdentityIcon pubKey={exampleIdentity} size={26} /></span><span>Mara<span className={styles.contactHint}>a familiar name</span></span><span className={styles.identityPlus} aria-hidden="true">+</span></summary>
                    <div className={styles.identityPopover}><p>A name on your side.<br />An address underneath.</p><code>041976a9…76a9ff</code><small>Display-only identity, not a contact you can message.</small></div>
                  </details>
                  <span className={styles.channelStatus}><span className={styles.statusDot} aria-hidden="true" />Sealed</span>
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

        <section className={styles.ticker} aria-hidden="true">
          <div className={styles.tickerTrack}>
            {[0, 1].map(copy => <span className={styles.tickerGroup} key={copy}>{tickerItems.map(item => <span className={styles.tickerItem} key={item}>{item}</span>)}</span>)}
          </div>
        </section>

        <section className={styles.metrics} aria-label="At a glance">
          <dl className={styles.metricGrid}>
            {metrics.map(metric => <div className={styles.metric} key={metric.label}>
              <dd className={styles.metricValue}>{metric.value}</dd>
              <dt className={styles.metricLabel}>{metric.label}</dt>
            </div>)}
          </dl>
        </section>

        <section id="your-conversation" className={styles.continuation} data-continuation aria-labelledby="continuation-title">
          <div className={styles.continuationCopy}><p className={styles.kicker}>From an ordinary moment</p><h2 id="continuation-title">To a conversation<br /><em>only you could have.</em></h2></div>
          <div className={styles.echo}>
            <span className={styles.echoLine} aria-hidden="true" />
            <div className={styles.echoNote}><span className={styles.sender}>You</span><p data-echo>“I thought you’d like this.”</p><span className={styles.echoCaption} data-echo-caption>It can start with something small.</span></div>
          </div>
          <div className={styles.invitation}><Button asChild size="lg" className={styles.primaryEntry}><Link prefetch={false} href="/login">Start your conversation <Arrow /></Link></Button><p className={styles.entryNote}>An identity on your device.<br />No email address or phone number.</p></div>
        </section>

        <section id="capabilities" className={styles.section} aria-labelledby="capabilities-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>What is inside</p>
            <h2 id="capabilities-title" className={styles.sectionTitle}>Everything the conversation needs,<br />and nothing that watches it.</h2>
          </div>
          <div className={styles.capabilityGrid}>
            {capabilities.map(capability => <article className={styles.capability} key={capability.index}>
              <span className={styles.capabilityIndex}>{capability.index}</span>
              <h3 className={styles.capabilityTitle}>{capability.title}</h3>
              <p className={styles.capabilityBody}>{capability.body}</p>
            </article>)}
          </div>
        </section>

        <section className={styles.pillars} aria-labelledby="pillars-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>The aim</p>
            <h2 id="pillars-title" className={styles.sectionTitle}>A conversation that belongs<br />to the people having it.</h2>
          </div>
          <ol className={styles.pillarList}>
            {pillars.map((pillar, index) => <li className={styles.pillar} key={pillar}>
              <span className={styles.pillarIndex}>{String(index + 1).padStart(2, "0")}</span>
              <p className={styles.pillarBody}>{pillar}</p>
            </li>)}
          </ol>
        </section>

        <section id="encryption" className={styles.section} aria-labelledby="encryption-title">
          <div className={styles.encryptionGrid}>
            <div>
              <p className={styles.kicker}>Encryption</p>
              <h2 id="encryption-title" className={styles.sectionTitle}>Sealed here,<br />readable only there.</h2>
              <p className={styles.sectionBody}>Every message is encrypted on this device with a key derived from the recipient’s public key. The relay authenticates and forwards the envelope; it never holds a key that opens it. Files are split into bounded parts, encrypted, and authenticated before they are opened or downloaded.</p>
              <div className={styles.actions}><Button asChild variant="outline"><a href={repository} target="_blank" rel="noopener noreferrer">Read the source <Arrow diagonal /></a></Button><a className={styles.textLink} href={`${repository}#readme`} target="_blank" rel="noopener noreferrer">Implementation notes <Arrow diagonal /></a></div>
            </div>
            <dl className={styles.specList}>
              {specifications.map(specification => <div className={styles.specRow} key={specification.term}>
                <dt className={styles.specTerm}>{specification.term}</dt>
                <dd className={styles.specValue}>{specification.value}</dd>
              </div>)}
            </dl>
          </div>
        </section>

        <section id="faq" className={styles.section} aria-labelledby="faq-title">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Questions</p>
            <h2 id="faq-title" className={styles.sectionTitle}>Frequently asked</h2>
          </div>
          <div className={styles.faqList}>
            {faqs.map(faq => <details className={styles.faq} key={faq.question}>
              <summary><span className={styles.faqQuestion}>{faq.question}</span><span className={styles.faqSign} aria-hidden="true">+</span></summary>
              <p className={styles.faqAnswer}>{faq.answer}</p>
            </details>)}
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <a href="#serotine-landing" className={styles.footerBrand}><AppLogo /></a>
          <a className={styles.footerLink} href={repository} target="_blank" rel="noopener noreferrer">Open source <Arrow diagonal /></a>
        </div>
        <div className={styles.footerColumns}>
          <div className={styles.footerColumn}>
            <p className={styles.footerHeading}>Product</p>
            <a href="#capabilities">Capabilities</a>
            <a href="#encryption">Encryption</a>
            <a href="#your-conversation">Get started</a>
          </div>
          <div className={styles.footerColumn}>
            <p className={styles.footerHeading}>Reading</p>
            <a href="#faq">FAQ</a>
            <a href={`${repository}#readme`} target="_blank" rel="noopener noreferrer">Documentation</a>
            <a href={`${repository}/blob/main/docs/SIP-1-communities.md`} target="_blank" rel="noopener noreferrer">Protocol notes</a>
          </div>
          <div className={styles.footerColumn}>
            <p className={styles.footerHeading}>Limits</p>
            <span>Unaudited software</span>
            <span>No forward secrecy</span>
            <span>Relay keeps ciphertext 7 days</span>
          </div>
        </div>
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
