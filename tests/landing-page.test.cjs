const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const root = path.resolve(__dirname, "..")
const read = file => fs.readFileSync(path.join(root, file), "utf8")
const source = read("app/page.tsx"), controls = read("app/landing-controls.tsx")
const behavior = read("app/landing-behavior.ts"), css = read("app/landing.module.css")
const classes = Object.fromEntries([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => [m[1], m[1]]))
const compile = (text, name) => ts.transpileModule(text, { fileName: name, compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true })
// Pure document contract, not a React renderer or a hydration test. Components
// are traversed as JSX records; interactions are tested in the browser script.
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }
const pageExports = {}
vm.runInNewContext(compile(source, "page.tsx").outputText, {
  exports: pageExports, React,
  require(name) {
    if (name === "next/link") return { default: props => React.createElement("a", props, props.children) }
    if (name === "./landing.module.css") return { default: classes }
    if (name === "./landing-controls") return { LandingEnhancements: () => null, ThemeControl: () => React.createElement("button", { disabled: true, "aria-label": "Change color theme" }) }
    if (name === "@/components/ui/identity-icon") return { IdentityIcon: () => React.createElement("span", { "aria-hidden": true }) }
    throw new Error(`Unexpected dependency: ${name}`)
  },
})
const elements = []
function visit(node) {
  if (node == null || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(visit).join("")
  if (typeof node !== "object") return String(node)
  if (typeof node.type === "function") return visit(node.type(node.props))
  const item = { tag: node.type, props: node.props, text: "" }
  elements.push(item); item.text = visit(node.props.children); return item.text
}
const text = visit(React.createElement(pageExports.default))
const find = tag => elements.filter(e => e.tag === tag)
const logic = {}; vm.runInNewContext(compile(behavior, "landing-behavior.ts").outputText, { exports: logic })

test("all landing TypeScript transpiles and every CSS module reference exists", () => {
  for (const [name, code] of [["page.tsx", source], ["landing-controls.tsx", controls], ["landing-behavior.ts", behavior]]) {
    assert.deepEqual(compile(code, name).diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [])
    const ast = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function inspect(node) { if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === "styles") assert.ok(classes[node.name.text], node.name.text); ts.forEachChild(node, inspect) }
    inspect(ast)
  }
  assert.match(pageExports.metadata.description, /Private messaging/)
})

test("first document identifies the product and shares one story, thread and composer", () => {
  assert.equal(find("h1").length, 1); assert.equal(find("main").length, 1)
  assert.match(text, /Private messaging for the people you choose/)
  for (const attribute of ["data-story", "data-conversation", "data-demo-log", "data-room", "data-demo-form", "data-echo"]) assert.equal(elements.filter(e => attribute in e.props).length, 1, attribute)
  assert.ok(find("summary").some(e => e.text.includes("Write something back")))
  assert.equal(find("textarea").length, 1)
})

test("unique targets, keyboard skip link and real non-prefetching app routes", () => {
  const ids = elements.filter(e => e.props.id).map(e => e.props.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const link of find("a")) {
    assert.notEqual(link.props.href, "#")
    if (link.props.href.startsWith("#")) assert.ok(ids.includes(link.props.href.slice(1)))
    if (link.props.href.startsWith("/")) assert.ok(["/", "/login"].includes(link.props.href))
    if (link.props.href === "/login") assert.equal(link.props.prefetch, false)
    if (link.props.target === "_blank") { assert.match(link.props.rel, /noopener/); assert.match(link.props.rel, /noreferrer/) }
  }
  assert.equal(find("a").filter(e => e.props.href === "/login").length, 2)
  assert.ok(find("a").some(e => e.text === "Skip to content" && e.props.href === "#main"))
})

test("demo remains opt-in, bounded, disabled until ready and honestly labeled", () => {
  assert.ok(find("fieldset").some(e => e.props.disabled === true))
  assert.equal(find("textarea")[0].props.maxLength, logic.MAX_NOTE_LENGTH)
  assert.ok(find("div").some(e => e.props.role === "log" && e.props["aria-live"] === "polite"))
  assert.match(text, /Scripted replies, not a person or AI/)
  assert.match(text, /Nothing is sent or saved/)
  assert.equal(logic.MAX_DEMO_NOTES, 8)
  assert.match(behavior, /content\.textContent = text/)
  assert.match(behavior, /echo!\.textContent = text/)
  assert.doesNotMatch(source + behavior, /dangerouslySetInnerHTML|\.innerHTML\s*=/)
})

test("no account, messaging, network, persistence or palette mutation in enhancement", () => {
  assert.doesNotMatch(source + controls + behavior, /createIdentity|useMessaging|messaging-provider|fetch\(|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|crypto\.|selectPalette|resetPalette|setItem|removeItem/)
  assert.match(controls, /useTheme/)
  assert.match(controls, /setTheme\(resolvedTheme/)
})

test("rules are deterministic and never imply a live human, AI or encryption test", () => {
  for (let turn = 0; turn < 10; turn++) for (const note of ["hello", "1976", "privacy", "Are you real?", "a thought", "<script>alert(1)</script>"]) {
    const value = logic.replyFor(note, turn)
    assert.equal(value, logic.replyFor(note, turn)); assert.ok(value.length > 0 && value.length < 280)
  }
  assert.match(logic.replyFor("Are you AI?", 0), /No person or AI/)
  assert.match(logic.replyFor("privacy", 0), /isn’t an encryption test/)
  assert.match(logic.replyFor("1976", 0), /margin note/)
  assert.equal(typeof logic.replyFor("a thought", NaN), "string")
})

test("scroll has distinct gather, sealed, arrival phases and reverses deterministically", () => {
  assert.equal(logic.storyFrame(0).gather, 0)
  assert.equal(logic.storyFrame(0).seal, 0)
  assert.equal(logic.storyFrame(.46).gather, 1)
  assert.equal(logic.storyFrame(.46).seal, 1)
  assert.equal(logic.storyFrame(.46).arrive, 0)
  assert.equal(logic.storyFrame(.9).seal, 0)
  assert.equal(logic.storyFrame(.9).arrive, 1)
  for (const p of [-1, 0, .1, .3, .5, .7, .9, 1, 2, NaN]) {
    const frame = logic.storyFrame(p)
    for (const value of Object.values(frame)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
    assert.deepEqual(frame, logic.storyFrame(p))
  }
})

test("progress clamps restored, negative, short and invalid geometry", () => {
  assert.equal(logic.storyProgress(100, 1800, 900), 0)
  assert.equal(logic.storyProgress(-450, 1800, 900), .5)
  assert.equal(logic.storyProgress(-900, 1800, 900), 1)
  assert.equal(logic.storyProgress(-1000, 100, 900), 1)
  assert.equal(logic.storyProgress(NaN, 0, 0), 0)
})

test("event-driven motion suspends for interaction and cleans up", () => {
  assert.match(behavior, /requestAnimationFrame\(paint\)/)
  assert.doesNotMatch(behavior, /setInterval|setTimeout/)
  for (const term of [/scrollEvents\?\.abort\(\)/, /observer\?\.disconnect\(\)/, /cancelAnimationFrame\(frame\)/, /room\.open \|\| identity\.open/, /visibilitychange/, /pagehide/, /pageshow/, /finePointer/]) assert.match(behavior, term)
  assert.match(behavior, /!event\.isComposing/); assert.match(behavior, /event\.keyCode !== 229/)
  assert.match(css, /data-interacting="true"/)
})

test("warm/plum art direction survives with unpinned mobile and reduced-motion fallback", () => {
  assert.match(css, /--paper:\s*#f6f4ef/); assert.match(css, /--paper:\s*#201e23/)
  assert.match(css, /:global\(\.dark\) \.landing/)
  assert.match(css, /min-width:\s*801px/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /animation:\s*none\s*!important/)
  assert.match(css, /--arrive:\s*1\s*!important/)
  assert.doesNotMatch(css, /@import|@font-face|https?:|#ccff89|#a9ed68|#b5ff69|backdrop-filter/)
})

test("real limitations and optional cryptography source are retained", () => {
  for (const phrase of ["has not undergone an independent security audit", "does not provide forward secrecy", "routing addresses and timing", "seven days", "does not erase a recipient’s copy", "no real message or key is created"]) assert.ok(text.includes(phrase), phrase)
  assert.ok(find("details").some(e => e.text.includes("A margin note") && e.text.includes("Whitfield Diffie and Martin Hellman")))
  assert.equal(find("canvas").length, 0); assert.equal(find("img").length, 0)
})

test("actual small-text and control token contrast remains readable in both themes", () => {
  function luminance(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0) }
  const ratio = (a, b) => { const x = [luminance(a), luminance(b)].sort((a, b) => a - b); return (x[1] + .05) / (x[0] + .05) }
  for (const block of [css.match(/\.landing \{([\s\S]*?)\n\}/)[1], css.match(/:global\(\.dark\) \.landing \{([\s\S]*?)\n\}/)[1]]) {
    const token = name => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1]
    for (const background of ["paper", "surface", "note"]) assert.ok(ratio(token("muted-ink"), token(background)) >= 4.5, background)
    assert.ok(ratio(token("input-line"), token("surface")) >= 3)
    assert.ok(ratio(token("focus"), token("paper")) >= 3)
  }
})
