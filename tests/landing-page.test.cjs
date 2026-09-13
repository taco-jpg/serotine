const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const React = require("react")
const root = path.resolve(__dirname, "..")
const read = file => fs.readFileSync(path.join(root, file), "utf8")
const source = read("app/page.tsx")
const controls = read("app/landing-controls.tsx")
const behavior = read("app/landing-behavior.ts")
const css = read("app/landing.module.css")
const classes = Object.fromEntries([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => [m[1], m[1]]))
const compile = (text, fileName) => ts.transpileModule(text, {
  fileName, compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true,
})
const compiled = compile(source, "page.tsx")
const pageExports = {}
// Server-document contract only. Interactive behavior is exercised separately
// in the browser smoke test, not replaced by a pretend React hydration test.
vm.runInNewContext(compiled.outputText, {
  exports: pageExports, React,
  require(name) {
    if (name === "next/link") return { default: props => React.createElement("a", props, props.children) }
    if (name === "./landing.module.css") return { default: classes }
    if (name === "./landing-controls") return {
      LandingEnhancements: () => null,
      ThemeControl: () => React.createElement("button", { type: "button", disabled: true, "aria-label": "Change color theme" }),
    }
    if (name === "@/components/ui/identity-icon") return { IdentityIcon: () => React.createElement("span", { "aria-hidden": true }) }
    throw new Error(`Unexpected dependency: ${name}`)
  },
})
const elements = []
function visit(node) {
  if (node == null || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(visit).join("")
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (typeof node.type === "function") return visit(node.type(node.props))
  if (typeof node.type === "symbol") return visit(node.props.children)
  const item = { tag: node.type, props: node.props, text: "" }
  elements.push(item); item.text = visit(node.props.children)
  return item.text
}
const text = visit(React.createElement(pageExports.default))
const find = tag => elements.filter(e => e.tag === tag)
const logic = {}
vm.runInNewContext(compile(behavior, "landing-behavior.ts").outputText, { exports: logic })

test("all landing TypeScript transpiles and referenced module classes exist", () => {
  for (const [name, code] of [["page.tsx", source], ["landing-controls.tsx", controls], ["landing-behavior.ts", behavior]]) {
    assert.deepEqual(compile(code, name).diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [])
    const ast = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function inspect(node) {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === "styles") assert.ok(classes[node.name.text], `Missing class ${node.name.text}`)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
  }
  assert.match(pageExports.metadata.title, /Serotine/)
})

test("server document has semantic landmarks, unique IDs and valid anchor targets", () => {
  assert.equal(find("h1").length, 1); assert.equal(find("main").length, 1)
  const ids = elements.filter(e => e.props.id).map(e => e.props.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const anchor of find("a").filter(e => e.props.href.startsWith("#"))) assert.ok(ids.includes(anchor.props.href.slice(1)))
  assert.ok(find("a").some(e => e.text === "Skip to content" && e.props.href === "#main"))
  assert.match(css, /\.skipLink:focus\s*\{/)
})

test("entry links retain real app routes, without account creation on the landing", () => {
  assert.ok(find("a").filter(e => e.props.href === "/login").length >= 2)
  for (const link of find("a")) {
    assert.notEqual(link.props.href, "#")
    if (link.props.href.startsWith("/")) assert.ok(["/", "/login"].includes(link.props.href))
    if (link.props.target === "_blank") { assert.match(link.props.rel, /noopener/); assert.match(link.props.rel, /noreferrer/) }
  }
  assert.doesNotMatch(source + controls + behavior, /createIdentity|useMessaging|messaging-provider|fetch\(|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|crypto\./)
})

test("demo is opt-in, honestly labeled, bounded and disabled before enhancement", () => {
  assert.ok(find("details").some(e => e.props["data-room"] !== undefined))
  assert.ok(find("fieldset").some(e => e.props.disabled === true))
  assert.ok(find("textarea").some(e => e.props.maxLength === logic.MAX_NOTE_LENGTH))
  assert.ok(find("div").some(e => e.props.role === "log" && e.props["aria-live"] === "polite"))
  assert.match(text, /Scripted replies, not a person or AI/)
  assert.match(text, /Nothing is sent or saved/)
  assert.match(text, /Closing this room clears it/)
  assert.equal(logic.MAX_DEMO_NOTES, 8)
  assert.match(behavior, /content\.textContent = text/)
  assert.doesNotMatch(source + behavior, /dangerouslySetInnerHTML|\.innerHTML\s*=/)
})

test("scripted replies are deterministic and do not impersonate a person", () => {
  for (let turn = 0; turn < 8; turn++) for (const note of ["Hello", "hello", "1976", "privacy", "Are you a real person?", "a thought", "<script>alert(1)</script>"]) {
    const reply = logic.replyFor(note, turn)
    assert.equal(reply, logic.replyFor(note, turn)); assert.equal(typeof reply, "string"); assert.ok(reply.length > 0 && reply.length < 280)
  }
  assert.match(logic.replyFor("are you AI?", 0), /No person or AI/)
  assert.match(logic.replyFor("privacy", 0), /isn’t an encryption test/)
  assert.match(logic.replyFor("1976", 0), /margin note/)
})

test("scroll progress clamps and handles short and restored pages", () => {
  assert.equal(logic.storyProgress(100, 1800, 900), 0)
  assert.equal(logic.storyProgress(0, 1800, 900), 0)
  assert.equal(logic.storyProgress(-450, 1800, 900), .5)
  assert.equal(logic.storyProgress(-900, 1800, 900), 1)
  assert.equal(logic.storyProgress(-1000, 100, 900), 1)
})

test("motion is event-driven, cleaned up, and never hides essential content", () => {
  assert.match(behavior, /requestAnimationFrame\(paint\)/)
  assert.doesNotMatch(behavior, /setInterval|setTimeout/)
  assert.match(behavior, /scrollEvents\?\.abort\(\)/)
  assert.match(behavior, /observer\?\.disconnect\(\)/)
  assert.match(behavior, /cancelAnimationFrame\(frame\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /animation:\s*none\s*!important/)
  assert.match(css, /--reply:\s*1\s*!important/)
  assert.match(css, /max-width:\s*640px/)
  assert.match(behavior, /!event\.isComposing/)
  assert.match(behavior, /event\.keyCode !== 229/)
})

test("both art directions are scoped and leave saved application palettes alone", () => {
  assert.match(css, /--paper:\s*#f6f4ef/)
  assert.match(css, /--paper:\s*#201e23/)
  assert.match(css, /:global\(\.dark\) \.landing/)
  assert.match(controls, /useTheme/)
  assert.match(controls, /setTheme\(resolvedTheme/)
  assert.doesNotMatch(controls + behavior, /selectPalette|resetPalette|setItem|removeItem/)
  assert.doesNotMatch(css, /@import|@font-face|https?:|#ccff89|#a9ed68|#b5ff69|backdrop-filter/)
})

test("important limitations remain discoverable rather than erased", () => {
  for (const phrase of ["has not undergone an independent security audit", "does not provide forward secrecy", "routing addresses and timing", "seven days", "does not erase a recipient’s copy", "no real message or key is created"]) assert.ok(text.includes(phrase), phrase)
  assert.ok(find("details").some(e => e.text.includes("A few things to know")))
  assert.equal(find("canvas").length, 0); assert.equal(find("img").length, 0)
  assert.doesNotMatch(source, /SignalSphere|ProtocolDiagram|THE CYPHERPUNKS|THE BREAKTHROUGH/)
})

test("cryptography reference is optional, attributed, and linked to the paper", () => {
  assert.ok(find("details").some(e => e.text.includes("A margin note") && e.text.includes("Whitfield Diffie and Martin Hellman")))
  assert.ok(find("a").some(e => e.props.href === "https://doi.org/10.1109/TIT.1976.1055638"))
  assert.equal(find("h2").filter(e => /1976|crypto|history|lineage/i.test(e.text)).length, 0)
})

test("small text and input borders meet contrast targets in both themes", () => {
  function luminance(hex) {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    return channels.reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  }
  const ratio = (a, b) => { const x = [luminance(a), luminance(b)].sort((a, b) => a - b); return (x[1] + .05) / (x[0] + .05) }
  // Read the actual first light and dark token sets, not independent test colors.
  const blocks = [css.match(/\.landing \{([\s\S]*?)\n\}/)[1], css.match(/:global\(\.dark\) \.landing \{([\s\S]*?)\n\}/)[1]]
  for (const block of blocks) {
    const token = name => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1]
    for (const background of ["paper", "surface", "note"]) assert.ok(ratio(token("muted-ink"), token(background)) >= 4.5, `Muted text on ${background}`)
    assert.ok(ratio(token("input-line"), token("surface")) >= 3)
    assert.ok(ratio(token("focus"), token("paper")) >= 3)
  }
})
