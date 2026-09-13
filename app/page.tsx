import type { Metadata } from "next"
import Link from "next/link"
import styles from "./landing.module.css"

const repository = "https://github.com/taco-jpg/serotine"
const manifesto = "https://www.activism.net/cypherpunk/manifesto.html"

export const metadata: Metadata = {
  title: "Serotine — Your words. Not the world's.",
  description:
    "Encrypted conversations with an identity you create on your own device. No phone number. No email address. Explore the ideas behind Serotine.",
}

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h16m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Mark() {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
      <path d="M27 7H14L5 16h17l-9 13H4M32 7l-9 13H10l-5 9M14 7l-9 9M22 16l-9 13h14l5-9" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" />
    </svg>
  )
}

// Deterministic SVG geometry: generated on the server, not a canvas/render loop.
function SignalSphere() {
  const particles = Array.from({ length: 116 }, (_, i) => {
    const y = 1 - (i / 115) * 2
    const radius = Math.sqrt(1 - y * y)
    const angle = i * 2.399963229728653
    const z = Math.sin(angle) * radius
    return { x: 310 + Math.cos(angle) * radius * 174, y: 288 + y * 174, z }
  })

  return (
    <div className={styles.signal}>
      <div className={styles.signalHeader} aria-hidden="true">
        <span><i /> SIGNAL STUDY / 001</span><span>FORM, NOT TELEMETRY</span>
      </div>
      <input className={styles.motionInput} type="checkbox" id="pause-signal" />
      <label className={styles.motionControl} htmlFor="pause-signal">
        <span className={styles.motionIcon} aria-hidden="true">Ⅱ</span>
        <span>Pause motion</span>
      </label>
      <span className={styles.reducedMotionNote}>Reduced motion is enabled</span>
      <div className={styles.signalArt} aria-hidden="true">
        <svg className={styles.orb} viewBox="0 0 620 580" fill="none" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="signal-halo"><stop stopColor="#a9ed68" stopOpacity=".15" /><stop offset=".6" stopColor="#8bcc4e" stopOpacity=".045" /><stop offset="1" stopColor="#8bcc4e" stopOpacity="0" /></radialGradient>
            <radialGradient id="signal-core" cx="35%" cy="28%"><stop stopColor="#202b1b" /><stop offset=".65" stopColor="#10180f" /><stop offset="1" stopColor="#0a0e0a" /></radialGradient>
            <linearGradient id="signal-wire" x1="138" y1="105" x2="467" y2="475" gradientUnits="userSpaceOnUse"><stop stopColor="#dcff9b" stopOpacity=".82" /><stop offset=".48" stopColor="#acde73" stopOpacity=".21" /><stop offset="1" stopColor="#b5ff69" stopOpacity=".64" /></linearGradient>
            <linearGradient id="signal-orbit" x1="56" y1="123" x2="540" y2="420" gradientUnits="userSpaceOnUse"><stop stopColor="#c7ff83" stopOpacity="0" /><stop offset=".5" stopColor="#c7ff83" stopOpacity=".95" /><stop offset="1" stopColor="#c7ff83" stopOpacity=".08" /></linearGradient>
          </defs>
          <circle cx="310" cy="288" r="286" fill="url(#signal-halo)" />
          <g stroke="#849173" strokeOpacity=".17" strokeWidth=".7">
            <path d="M310 16v544M38 288h544" strokeDasharray="2 7" />
            <circle cx="310" cy="288" r="247" strokeDasharray="2 10" />
            <circle cx="310" cy="288" r="224" />
            <path d="M72 55H56v16m492-16h16v16M56 509v16h16m492-16v16h-16" />
          </g>
          <g className={styles.outerOrbit}>
            <ellipse cx="310" cy="288" rx="278" ry="106" transform="rotate(-31 310 288)" stroke="url(#signal-orbit)" strokeWidth="1.2" />
            <ellipse cx="310" cy="288" rx="248" ry="91" transform="rotate(40 310 288)" stroke="#a3cc70" strokeOpacity=".24" strokeWidth=".8" />
            <circle cx="548" cy="145" r="4" fill="#d1ff8e" />
            <circle cx="548" cy="145" r="10" stroke="#d1ff8e" strokeOpacity=".35" />
            <circle cx="118" cy="123" r="3" fill="#afc68e" />
          </g>
          <circle cx="310" cy="288" r="175" fill="url(#signal-core)" stroke="#c2f28c" strokeOpacity=".35" />
          <g className={styles.wireSphere} stroke="url(#signal-wire)" strokeWidth=".75">
            {Array.from({ length: 12 }, (_, i) => <ellipse key={`meridian-${i}`} cx="310" cy="288" rx={Number((175 * Math.sin(((i + 1) / 12) * Math.PI / 2)).toFixed(3))} ry="175" transform="rotate(-24 310 288)" />)}
            {Array.from({ length: 13 }, (_, i) => {
              const offset = (i - 6) * 25
              return <ellipse key={`latitude-${i}`} cx="310" cy={288 + offset} rx={Number(Math.sqrt(175 ** 2 - offset ** 2).toFixed(3))} ry={Number((28 * Math.sqrt(1 - (offset / 175) ** 2)).toFixed(3))} transform="rotate(-24 310 288)" />
            })}
          </g>
          <g className={styles.particles}>
            {particles.map((point, i) => <circle key={i} cx={point.x.toFixed(3)} cy={point.y.toFixed(3)} r={point.z > .4 ? 1.9 : 1} fill="#d6ffa1" opacity={((point.z + 1.5) / 3).toFixed(3)} />)}
          </g>
          <g className={styles.innerOrbit}>
            <ellipse cx="310" cy="288" rx="198" ry="65" transform="rotate(-31 310 288)" stroke="#d8ffa6" strokeOpacity=".65" strokeWidth="1" strokeDasharray="80 16 2 16" />
            <circle cx="140" cy="390" r="3" fill="#dcffae" />
          </g>
          <g fill="#a4b291" fontFamily="monospace" fontSize="9" letterSpacing="1.4">
            <text x="39" y="286">[ A ]</text><text x="553" y="286">[ B ]</text>
            <text x="286" y="32">0x01</text><text x="272" y="553">PRIVATE BY INTENT</text>
            <text x="435" y="78">01010011</text><text x="78" y="481">0x 73 65 72</text>
          </g>
          <path d="M168 196h-41l-19-20H63m393 200h43l18 20h47" stroke="#81926d" strokeWidth=".7" />
          <g fill="#c1cdb0" fontFamily="monospace" fontSize="8" letterSpacing="1.2"><text x="64" y="165">YOUR IDENTITY</text><text x="485" y="415">YOUR WORDS</text></g>
        </svg>
      </div>
      <details className={styles.signalDemo}>
        <summary><span className={styles.demoDot} /><span>Reveal the example</span><span className={styles.demoPlus} aria-hidden="true">+</span></summary>
        <div className={styles.revealedMessage}>Hello, friend. Just between us.</div>
      </details>
      <div className={styles.cipherReadout} aria-hidden="true"><span>PAYLOAD</span><code>7F A2 9C 01 E8 B4 6D F0 3A C7</code></div>
      <p className={styles.demoCaption}>Illustrative ciphertext. No real message or key is created.</p>
    </div>
  )
}

function ProtocolDiagram({ kind }: { kind: "identity" | "message" | "backup" }) {
  return (
    <svg className={styles.protocolDiagram} viewBox="0 0 320 112" fill="none" aria-hidden="true" focusable="false">
      {kind === "identity" ? <>
        <rect x="18" y="24" width="92" height="63" rx="5" stroke="currentColor" strokeOpacity=".45" />
        <path d="M30 39h30m-30 10h50M30 70h12m5 0h12" stroke="currentColor" strokeOpacity=".45" />
        <path d="M111 55h53l20-18h31" stroke="currentColor" strokeDasharray="3 5" />
        <circle cx="229" cy="38" r="12" stroke="currentColor" /><path d="M241 38h51m-12 0v9m-10-9v9" stroke="currentColor" />
        <path d="M165 55v23h49" stroke="currentColor" strokeOpacity=".4" strokeDasharray="3 5" /><rect x="215" y="67" width="79" height="23" rx="3" stroke="currentColor" strokeOpacity=".4" />
        <text x="226" y="82" fill="currentColor" fontFamily="monospace" fontSize="9">0x…yours</text>
      </> : kind === "message" ? <>
        <rect x="18" y="32" width="66" height="49" rx="5" stroke="currentColor" strokeOpacity=".45" /><rect x="238" y="32" width="66" height="49" rx="5" stroke="currentColor" strokeOpacity=".45" />
        <path d="M84 57h49m55 0h50" stroke="currentColor" strokeOpacity=".7" strokeDasharray="3 5" />
        <rect x="134" y="40" width="53" height="36" rx="4" stroke="currentColor" /><path d="M151 40v-8a10 10 0 0 1 20 0v8m-10 13v10" stroke="currentColor" />
        <text x="37" y="61" fill="currentColor" fontFamily="monospace" fontSize="10">YOU</text><text x="251" y="61" fill="currentColor" fontFamily="monospace" fontSize="10">THEM</text>
      </> : <>
        <rect x="28" y="37" width="79" height="60" rx="4" stroke="currentColor" strokeOpacity=".25" /><rect x="37" y="28" width="79" height="60" rx="4" stroke="currentColor" strokeOpacity=".4" /><rect x="46" y="19" width="79" height="60" rx="4" fill="#10140f" stroke="currentColor" strokeOpacity=".65" />
        <path d="M64 38h31m-31 11h42m-42 11h22M126 51h85m-8-7 8 7-8 7" stroke="currentColor" strokeOpacity=".65" />
        <rect x="228" y="26" width="53" height="61" rx="5" stroke="currentColor" strokeOpacity=".5" /><path d="M248 76h12" stroke="currentColor" />
        <circle cx="255" cy="49" r="8" stroke="currentColor" /><path d="M255 57v9" stroke="currentColor" />
      </>}
    </svg>
  )
}

const history = [
  {
    year: "1976", tag: "THE BREAKTHROUGH", title: "A secret, without a shared past.",
    text: "Whitfield Diffie and Martin Hellman publish New Directions in Cryptography, describing public-key cryptography and a way to establish a shared secret over a public channel.",
    source: "Read the original paper", href: "https://doi.org/10.1109/TIT.1976.1055638",
  },
  {
    year: "1991", tag: "IN PEOPLE’S HANDS", title: "Pretty good. Radically different.",
    text: "Phil Zimmermann releases Pretty Good Privacy on the internet for free. Encryption for personal email becomes something people can use, not just something institutions control.",
    source: "Read Zimmermann’s official biography", href: "https://www.internethalloffame.org/official-biography-philip-zimmermann/",
  },
  {
    year: "1993", tag: "THE CYPHERPUNKS", title: "Cypherpunks write code.",
    text: "Eric Hughes publishes A Cypherpunk’s Manifesto on March 9. The argument is practical: privacy needs people willing to build the tools that make it possible.",
    source: "Read the manifesto", href: manifesto,
  },
]

export default function LandingPage() {
  return (
    <div className={styles.landing}>
      <a href="#main" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Serotine home"><Mark /><span>serotine<span className={styles.brandDot}>.</span></span></Link>
        <nav className={styles.navigation} aria-label="Main navigation"><a href="#protocol">The protocol</a><a href="#lineage">The lineage</a><a href={repository} target="_blank" rel="noopener noreferrer">The source <Arrow diagonal /></a></nav>
        <Link href="/login" className={styles.headerCta}>Open app <Arrow diagonal /></Link>
      </header>
      <main id="main" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span className={styles.statusDot} /> PRIVATE COMMUNICATION. PUBLIC CONVICTION.</p>
            <h1 id="hero-title">Your words.<br />Not the<br /><span>world’s.</span><span className={styles.titleAsterisk} aria-hidden="true">✳</span></h1>
            <p className={styles.heroDescription}>Some conversations aren’t for everyone.<br />Encrypted messaging. An identity you create.<br />A space that starts with you.</p>
            <div className={styles.heroActions}><Link href="/login" className={styles.primaryCta}>Enter Serotine <Arrow diagonal /></Link><a href="#protocol" className={styles.textLink}>Explore the idea <span aria-hidden="true">↓</span></a></div>
            <p className={styles.heroFootnote}>NO PHONE NUMBER. NO EMAIL ADDRESS.</p>
          </div>
          <SignalSphere />
          <div className={styles.heroBottom}><span>BUILT ON CRYPTOGRAPHY. NOT OVERSHARING.</span><a href="#protocol" aria-label="Scroll to how Serotine works">SCROLL TO EXPLORE <span aria-hidden="true">↓</span></a></div>
        </section>
        <div className={styles.principleStrip} aria-label="Serotine principles">
          {["DEVICE-LOCAL IDENTITY", "ENCRYPTED CONVERSATIONS", "YOUR KEYS, YOUR BACKUP", "SOURCE YOU CAN READ"].map((text, index) => <div key={text}><span>0{index + 1}</span>{text}<span aria-hidden="true">↗</span></div>)}
        </div>
        <section id="protocol" className={styles.protocol} aria-labelledby="protocol-title">
          <div className={styles.sectionTop}><p className={styles.eyebrow}>01 / THE PROTOCOL</p><span className={styles.sectionAside}>LESS REGISTRATION. MORE CONVERSATION.</span></div>
          <div className={styles.sectionHeading}><h2 id="protocol-title">Privacy isn’t a setting.<br /><span>It’s the starting point.</span></h2><p>You don’t need another profile.<br />You need a way to talk to your people.</p></div>
          <div className={styles.protocolGrid}>
            {[
              { kind: "identity" as const, number: "01", title: "Be a key. Not a profile.", text: "Your browser creates your private key and public contact address. Share the address, keep the key, and verify your contacts through a trusted channel.", label: "IDENTITY / GENERATED ON YOUR DEVICE" },
              { kind: "message" as const, number: "02", title: "The words are for them.", text: "Messages are encrypted before sending. Talk one-to-one, bring a group together, or share a file without handing the relay your message content.", label: "MESSAGES / ENCRYPTED BEFORE SENDING" },
              { kind: "backup" as const, number: "03", title: "Keep what matters.", text: "Conversations live in your browser. Export a password-encrypted backup to preserve your history or bring your identity to another device.", label: "RECOVERY / YOUR ENCRYPTED BACKUP" },
            ].map(item => <article className={styles.protocolItem} key={item.number}><div className={styles.itemNumber}><span>{item.number}</span><span aria-hidden="true">+</span></div><ProtocolDiagram kind={item.kind} /><h3>{item.title}</h3><p>{item.text}</p><span className={styles.itemLabel}>{item.label}</span></article>)}
          </div>
        </section>
        <section className={styles.manifesto} aria-labelledby="manifesto-quote">
          <div className={styles.manifestoMeta}><span>AN IDEA WORTH KEEPING ALIVE.</span><span>ARCHIVE / 09.03.1993</span></div>
          <blockquote id="manifesto-quote">“Privacy is the power to<br className={styles.quoteBreak} /> selectively reveal oneself<br className={styles.quoteBreak} /> to the world.”</blockquote>
          <div className={styles.manifestoBottom}><p>ERIC HUGHES<br /><span>A Cypherpunk’s Manifesto</span></p><a href={manifesto} target="_blank" rel="noopener noreferrer" aria-label="Read A Cypherpunk’s Manifesto"><Arrow diagonal /></a></div>
          <span className={styles.manifestoStar} aria-hidden="true">✳</span>
        </section>
        <section id="lineage" className={styles.lineage} aria-labelledby="lineage-title">
          <div className={styles.lineageIntro}><p className={styles.eyebrow}>02 / THE LINEAGE</p><h2 id="lineage-title">Before the app,<br />there was<br /><span>an idea.</span></h2><p>Privacy didn’t arrive with a product launch. It was argued for, written about, and built into code. These are a few of the moments behind it.</p><div className={styles.archiveStamp} aria-hidden="true"><span>1976</span><span>↘</span><span>TO<br />TODAY</span></div></div>
          <div className={styles.timeline}>
            {history.map(item => <details className={styles.historyEntry} key={item.year} open={item.year === "1993"}><summary><span className={styles.historyYear}>{item.year}</span><span className={styles.historySummary}><span>{item.tag}</span><strong>{item.title}</strong></span><span className={styles.historyPlus} aria-hidden="true">+</span></summary><div className={styles.historyBody}><p>{item.text}</p><a href={item.href} target="_blank" rel="noopener noreferrer">{item.source} <Arrow diagonal /></a></div></details>)}
            <div className={styles.historyNow}><span>NOW</span><p>Same conviction.<br /><strong>A new place to talk.</strong></p><Mark /></div>
          </div>
        </section>
        <section id="boundaries" className={styles.boundaries} aria-labelledby="boundaries-title">
          <div><p className={styles.eyebrow}>03 / NO FINE-PRINT ENERGY</p><h2 id="boundaries-title">Read the code.<br /><span>Know the limits.</span></h2><p className={styles.boundariesIntro}>Cryptography is a tool, not a force field. Being clear about what it doesn’t do is part of the point.</p><a className={styles.sourceLink} href={repository} target="_blank" rel="noopener noreferrer">Inspect Serotine on GitHub <Arrow diagonal /></a></div>
          <div className={styles.limits}>
            <div className={styles.auditNotice}><span aria-hidden="true">↗</span><p>Serotine has not undergone an independent security audit.</p></div>
            <details className={styles.limitEntry} open><summary>Encryption is not anonymity.<span aria-hidden="true">+</span></summary><p>The relay can see routing addresses and timing. Serotine uses long-lived identity keys and does not provide forward secrecy. Verify contact addresses separately.</p></details>
            <details className={styles.limitEntry}><summary>Your device is part of the boundary.<span aria-hidden="true">+</span></summary><p>Private keys and conversation history are stored in your browser. Someone with access to your unlocked browser or identity key can access sensitive data. Protect your devices and your backups.</p></details>
            <details className={styles.limitEntry}><summary>Local history needs a backup.<span aria-hidden="true">+</span></summary><p>The relay retains encrypted events for seven days, not forever. Clearing browser data without a usable backup can lose your identity and local history. Deleting your copy does not erase a recipient’s copy.</p></details>
          </div>
        </section>
        <section className={styles.finalCta} aria-labelledby="final-title"><p className={styles.eyebrow}>LESS BROADCAST. MORE CONNECTION.</p><div><h2 id="final-title">The next conversation<br /><span>is yours.</span></h2><Link className={styles.finalArrow} href="/login" aria-label="Start a conversation in Serotine"><Arrow diagonal /></Link></div><p>No phone number. No email address. Just a place to begin.</p></section>
      </main>
      <footer className={styles.footer}><div className={styles.footerTop}><Link href="/" className={styles.brand} aria-label="Serotine home"><Mark /><span>serotine<span className={styles.brandDot}>.</span></span></Link><p>PRIVATE COMMUNICATION.<br />PUBLIC CONVICTION.</p><nav aria-label="Footer navigation"><a href="#boundaries">Privacy &amp; limits</a><a href={repository} target="_blank" rel="noopener noreferrer">GitHub <Arrow diagonal /></a><Link href="/login">Open app <Arrow diagonal /></Link></nav></div><div className={styles.footerBottom}><span>A SMALL CORNER OF A VERY LOUD INTERNET.</span><a href="#main">BACK TO TOP ↑</a></div></footer>
    </div>
  )
}
