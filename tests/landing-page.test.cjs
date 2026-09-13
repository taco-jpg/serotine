const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const React = require("react")

const root = path.resolve(__dirname, "..")
const source = fs.readFileSync(path.join(root, "app/page.tsx"), "utf8")
const css = fs.readFileSync(path.join(root, "app/landing.module.css"), "utf8")
const classes = Object.fromEntries([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => [match[1], match[1]]))
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  reportDiagnostics: true,
})
const exportsObject = {}
const testReact = { ...React, Fragment: React.Fragment || Symbol.for("react.fragment") }
// Evaluate the real, pure server components. Only framework navigation and CSS
// module resolution are substituted; no DOM, transport, or identity is needed.
vm.runInNewContext(compiled.outputText, {
  exports: exportsObject,
  React: testReact,
  require(name) {
    if (name === "next/link") return { default: props => testReact.createElement("a", props, props.children) }
    if (name === "./landing.module.css") return { default: classes }
    throw new Error(`Unexpected landing-page dependency: ${name}`)
  },
})
const elements = []
function visit(node) {
  if (node == null || typeof node === "boolean") return ""
  if (Array.isArray(node)) return node.map(visit).join("")
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (typeof node.type === "function") return visit(node.type(node.props))
  if (typeof node.type === "symbol") return visit(node.props.children)
  const element = { tag: node.type, props: node.props, text: "" }
  elements.push(element)
  element.text = visit(node.props.children)
  return element.text
}
const text = visit(testReact.createElement(exportsObject.default))
const find = tag => elements.filter(element => element.tag === tag)

test("landing TSX transpiles and every referenced CSS class exists", () => {
  assert.deepEqual(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [])
  const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function inspect(node) {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === "styles") {
      assert.ok(classes[node.name.text], `Missing CSS class ${node.name.text}`)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(ast)
  assert.match(exportsObject.metadata.title, /Serotine/)
})

test("landing has one main and h1, and all in-page links have unique targets", () => {
  assert.equal(find("h1").length, 1)
  assert.equal(find("main").length, 1)
  const ids = elements.filter(element => element.props.id).map(element => element.props.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const anchor of find("a").filter(element => element.props.href.startsWith("#"))) {
    assert.ok(ids.includes(anchor.props.href.slice(1)), `Broken anchor ${anchor.props.href}`)
  }
  assert.ok(find("a").some(element => element.text === "Skip to content" && element.props.href === "#main"))
})

test("all application entry points retain /login and external links are safe", () => {
  assert.equal(find("a").filter(element => element.props.href === "/login").length, 4)
  for (const anchor of find("a")) {
    assert.ok(anchor.props.href && anchor.props.href !== "#")
    if (anchor.props.href.startsWith("/")) assert.ok(["/", "/login"].includes(anchor.props.href))
    if (anchor.props.target === "_blank") {
      assert.match(anchor.props.rel, /noopener/)
      assert.match(anchor.props.rel, /noreferrer/)
    }
  }
})

test("cryptography history retains dated sources and attributed manifesto", () => {
  const hrefs = find("a").map(element => element.props.href)
  assert.ok(hrefs.includes("https://doi.org/10.1109/TIT.1976.1055638"))
  assert.ok(hrefs.includes("https://www.internethalloffame.org/official-biography-philip-zimmermann/"))
  assert.ok(hrefs.includes("https://www.activism.net/cypherpunk/manifesto.html"))
  for (const year of ["1976", "1991", "1993"]) assert.ok(find("summary").some(element => element.text.includes(year)))
  assert.match(text, /ERIC HUGHES/)
})

test("native reveal, history, and motion controls need no client component", () => {
  assert.doesNotMatch(source, /["']use client["']|useEffect|useState|dangerouslySetInnerHTML/)
  assert.equal(find("details").length, 7)
  assert.equal(find("summary").length, 7)
  const input = find("input").find(element => element.props.id === "pause-signal")
  assert.equal(input.props.type, "checkbox")
  assert.ok(find("label").some(element => element.props.htmlFor === "pause-signal"))
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /animation-play-state:\s*paused/)
  assert.match(css, /animation:\s*none\s*!important/)
  assert.match(css, /motionInput:focus-visible\s*\+\s*\.motionControl/)
})

test("security boundaries and illustrative-demo labels remain explicit", () => {
  for (const phrase of [
    "has not undergone an independent security audit",
    "does not provide forward secrecy",
    "routing addresses and timing",
    "seven days",
    "does not erase a recipient’s copy",
    "No real message or key is created",
    "FORM, NOT TELEMETRY",
  ]) assert.ok(text.includes(phrase), `Missing limitation: ${phrase}`)
  assert.equal(find("script").length, 0)
  assert.equal(find("canvas").length, 0)
  assert.equal(find("img").length, 0)
  assert.doesNotMatch(source, /fetch\(|localStorage|sessionStorage|navigator\.|crypto\./)
  assert.doesNotMatch(css, /@import|@font-face|https?:|:global/)
})

test("generated vector geometry is finite and all SVG artwork is decorative", () => {
  for (const svg of find("svg")) assert.equal(svg.props["aria-hidden"], "true")
  for (const element of elements) {
    for (const attribute of ["cx", "cy", "r", "rx", "ry"]) {
      if (element.props[attribute] === undefined) continue
      // SVG gradients also accept percentage coordinates.
      const value = Number(String(element.props[attribute]).replace(/%$/, ""))
      assert.ok(Number.isFinite(value), `${element.tag}.${attribute} is not finite`)
      if (["r", "rx", "ry"].includes(attribute)) assert.ok(value >= 0)
    }
  }
})
