const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {execFileSync} = require('node:child_process')
const {validateOrigin} = require('../scripts/prepare.cjs')
test('mobile build origin excludes insecure and credential-bearing relays', () => {
  assert.equal(validateOrigin('https://relay.example.com'), 'https://relay.example.com')
  for (const value of ['http://relay.example.com', 'https://user:pass@relay.example.com', 'https://relay.example.com/path', 'https://relay.example.com?x=1', 'https://localhost', 'https://127.0.0.1', 'https://relay.example.com:8080']) assert.throws(() => validateOrigin(value))
})
test('actual Java bridge policy rejects host escapes, unsupported methods, headers and oversized bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serotine-native-policy-'))
  try {
    const source = path.join(__dirname, '../android/app/src/main/java/app/serotine/client/NativePolicy.java')
    const harness = path.join(dir, 'PolicyChecks.java')
    fs.writeFileSync(harness, `import app.serotine.client.NativePolicy;
public class PolicyChecks {
 static void rejects(Runnable action) { try { action.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError("Expected rejection"); }
 public static void main(String[] args) {
  NativePolicy.request("/api/files", "PUT"); NativePolicy.request("/api/relay", "POST");
  for(String p : new String[]{"https://evil.example/api/relay", "//evil.example/api/relay", "/api/relay?host=evil", "/api/../relay", "/api/relay/", "/api/%72elay"}) rejects(() -> NativePolicy.request(p,"POST"));
  rejects(() -> NativePolicy.request("/api/relay", "GET")); rejects(() -> NativePolicy.request("/api/files", "DELETE"));
  for(String h : new String[]{"Origin","Host","Cookie","Authorization","Referer","Connection","Sec-Fetch-Site"}) rejects(() -> NativePolicy.header(h,"x"));
  NativePolicy.header("X-Serotine-File-Request", "signed-envelope"); rejects(() -> NativePolicy.header("Accept", "x\\r\\nCookie: a"));
  rejects(() -> NativePolicy.relayOrigin("http://relay.example.com")); rejects(() -> NativePolicy.relayOrigin("https://user@relay.example.com"));
  rejects(() -> NativePolicy.filename("../secret")); rejects(() -> NativePolicy.filename("a\\\\b"));
  NativePolicy.encodedSize("YQ==", 1); rejects(() -> NativePolicy.encodedSize("YQ==\\n", 8)); rejects(() -> NativePolicy.encodedSize("AAAA", 0));
  NativePolicy.encodedSize("AAAA".repeat(1000000), 4000000); // bounded, stack-safe scan
  rejects(() -> NativePolicy.encodedSize("Y===", 8));
 }
}`)
    execFileSync('java', ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-d', dir, source, harness], {stdio:'pipe'})
    execFileSync('java', ['-cp', dir, 'PolicyChecks'], {stdio:'pipe'})
  } finally { fs.rmSync(dir, {recursive:true,force:true}) }
})
