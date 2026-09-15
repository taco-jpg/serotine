const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {DatabaseSync}=require('node:sqlite')
const {test}=require('node:test')
const ts=require('typescript')
const root=path.resolve(__dirname,'..')
async function harness(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close())
 for(const file of fs.readdirSync(path.join(root,'migrations')).sort())if(file.endsWith('.sql'))sqlite.exec(fs.readFileSync(path.join(root,'migrations',file),'utf8'))
 const state={failPut:false,corruptGet:false,failCommit:false},objects=new Map()
 const db={prepare(sql){let values=[];return {bind(...v){values=v;return this},async run(){if(state.failCommit&&sql.startsWith('UPDATE'))throw new Error('commit failed');return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}}}}}
 const schemaSource=ts.transpileModule(fs.readFileSync(path.join(root,'lib/event-relay-schema.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const schemaMod={exports:{}};new Function('require','module','exports',schemaSource)(require,schemaMod,schemaMod.exports)
 await schemaMod.exports.ensureEventRelaySchema(db)
 const files={async put(key,value){if(state.failPut)throw new Error('R2 failed');objects.set(key,value.slice(0))},async get(key){const bytes=objects.get(key);return bytes?{size:bytes.byteLength,arrayBuffer:async()=>state.corruptGet?new Uint8Array(bytes.byteLength).buffer:bytes.slice(0)}:null}}
 const source=ts.transpileModule(fs.readFileSync(path.join(root,'lib/relay-payloads.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const mod={exports:{}}
 new Function('require','module','exports',source)(name=>name==='@opennextjs/cloudflare'?{getCloudflareContext:async()=>({env:{SEROTINE_STORAGE_VERSION:'2',serotine_files:files}})}:require(name),mod,mod.exports)
 const seed=(table,value='ciphertext'.repeat(100))=>{
  const now=Date.now()
  if(table==='Message')sqlite.prepare("INSERT INTO Message VALUES(?, 'legacy-owner', ?, 'tomorrow', 'today')").run(crypto.randomUUID(),value)
  else if(table==='RelayMessage')sqlite.prepare("INSERT INTO RelayMessage VALUES(?, 'sender', 'recipient', ?, ?, ?)").run(crypto.randomUUID(),value,now,now+60000)
  else sqlite.prepare("INSERT INTO RelayEvent(id,senderPubKey,recipientPubKey,encryptedData,payloadBytes,createdAt,expiresAt) VALUES(?, 'sender', 'recipient', ?, ?, ?, ?)").run(crypto.randomUUID(),value,Buffer.byteLength(value),now,now+60000)
 }
 return {sqlite,db,files,state,objects,seed,...mod.exports}
}
test('migration is bounded and preserves IDs, cursors, expiry, quota and legacy readability',async t=>{
 const h=await harness(t)
 for(const table of ['RelayEvent','RelayMessage','Message'])h.seed(table)
 const before=Object.fromEntries(['RelayEvent','RelayMessage','Message'].map(table=>[table,h.sqlite.prepare(`SELECT * FROM ${table}`).get()]))
 const usage=h.sqlite.prepare('SELECT * FROM RelayEventUsage').get()
 assert.equal(await h.migrateRelayPayloads(h.db,h.files,2),2)
 assert.equal(h.sqlite.prepare('SELECT encryptedData FROM Message').get().encryptedData,before.Message.encryptedData)
 assert.equal(await h.migrateRelayPayloads(h.db,h.files,2),1)
 assert.equal(await h.migrateRelayPayloads(h.db,h.files,2),0)
 for(const table of ['RelayEvent','RelayMessage','Message']){
  const after=h.sqlite.prepare(`SELECT * FROM ${table}`).get()
  assert.match(after.encryptedData,/^@r2:v2:/)
  assert.deepEqual({...after,encryptedData:before[table].encryptedData},{...before[table]})
  assert.equal((await h.hydrateRelayPayloads([after]))[0].encryptedData,before[table].encryptedData)
 }
 assert.deepEqual(h.sqlite.prepare('SELECT * FROM RelayEventUsage').get(),usage)
 const bytes=h.sqlite.prepare(`SELECT SUM(${h.RELAY_PAYLOAD_BYTES_SQL}) AS n FROM RelayMessage`).get().n
 assert.equal(bytes,Buffer.byteLength(before.RelayMessage.encryptedData))
})
test('failed upload, corrupt verification or lost commit never discards an old payload and retries are safe',async t=>{
 const h=await harness(t);h.seed('RelayEvent')
 const before=h.sqlite.prepare('SELECT * FROM RelayEvent').get()
 for(const failure of ['failPut','corruptGet','failCommit']){
  h.state[failure]=true
  await assert.rejects(h.migrateRelayPayloads(h.db,h.files))
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM RelayEvent').get(),before)
  h.state[failure]=false
 }
 assert.equal(await h.migrateRelayPayloads(h.db,h.files),1)
 assert.equal(h.objects.size,1,'retry uses the same immutable content key')
 assert.equal((await h.hydrateRelayPayloads([h.sqlite.prepare('SELECT * FROM RelayEvent').get()]))[0].encryptedData,before.encryptedData)
})
test('new opaque packets including very small files are always externalized; references are not recursively trusted',async t=>{
 const h=await harness(t)
 for(const value of ['file'.repeat(8),'@r2:v2:{"key":"attacker-chosen"}', '界'.repeat(128)]){
  const stored=await h.storeRelayPayload(value)
  assert.ok(stored.startsWith('@r2:v2:'))
  assert.equal((await h.hydrateRelayPayloads([{encryptedData:stored}]))[0].encryptedData,value)
 }
})
