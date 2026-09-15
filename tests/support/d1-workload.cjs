/* Same signed application routes on both revisions; actual workerd D1 meta,
 * including index/trigger writes. No statement-count or SQLite changes estimate. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const esbuild = require('esbuild')
const { Miniflare } = require(require.resolve('miniflare', { paths: [path.dirname(require.resolve('wrangler/package.json'))] }))
const root = path.resolve(__dirname, '../..')
async function harness(sourceRoot = root, optimized = false) {
  const metricsSource = `
const counts = new Map(); const measuredCache = new WeakMap(); let mode = null; let now = Date.now(); Date.now = () => now;
function measured(db) {
 if(measuredCache.has(db))return measuredCache.get(db);
 const tally = (sql, r) => { if (r.meta) { const key = sql.replace(/\\s+/g,' ').trim(); counts.set(key,(counts.get(key)||0)+r.meta.rows_written) }; return r };
 const wrap = (sql, statement) => ({_sql:sql,_raw:statement, bind(...args){return wrap(sql,statement.bind(...args))},
 async run(){return tally(sql,await statement.run())}, async all(){return tally(sql,await statement.all())},
 async first(){return (await this.all()).results[0]??null}});
 const result={prepare(sql){return wrap(sql,db.prepare(sql))},async batch(items){const r=await db.batch(items.map(x=>x._raw));return r.map((v,i)=>tally(items[i]._sql,v))}}; measuredCache.set(db,result);return result;
}
export default {async fetch(request,env){
 const url = new URL(request.url);
 if(url.pathname==='/__mode'){mode=url.searchParams.get('value');return new Response('ok')}
 if(url.pathname==='/__metrics'){const result=Object.fromEntries(counts);if(url.searchParams.has('reset'))counts.clear();return Response.json(result)}
 if(url.pathname==='/__clock'){now=Number(url.searchParams.get('now'));return new Response('ok')}
 globalThis.__fixtureEnv={...env,...(mode?{SEROTINE_STORAGE_VERSION:mode}:{}),serotine_db:measured(env.serotine_db)};
 const mod=url.pathname==='/api/calls'?await import('./app/api/calls/route.ts'):url.pathname==='/api/files'?await import('./app/api/files/route.ts'):await import('./app/api/relay/route.ts');
 return mod[request.method](request);
}};`
  const built = await esbuild.build({ absWorkingDir: sourceRoot, entryPoints: ['custom-worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    plugins: [{name:'fixture',setup(b){
      b.onResolve({filter:/\.open-next\/worker\.js$/},()=>({path:'handler',namespace:'fixture'}))
      b.onResolve({filter:/^@opennextjs\/cloudflare$/},()=>({path:'context',namespace:'fixture'}))
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({resolveDir:sourceRoot,contents:args.path==='context'?'export function getCloudflareContext(){return {env:globalThis.__fixtureEnv}}':metricsSource}))
    }}]})
  const persist=fs.mkdtempSync(path.join(os.tmpdir(),'serotine-storage-'))
  const options={d1Persist:path.join(persist,'d1'),durableObjectsPersist:path.join(persist,'do'),r2Persist:path.join(persist,'r2'),name:'d1-workload',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-05-06',compatibilityFlags:['nodejs_compat'],
    serviceBindings:{WORKER_SELF_REFERENCE:'d1-workload'},d1Databases:['serotine_db'],r2Buckets:['serotine_files'],
    bindings: optimized ? {SEROTINE_STORAGE_VERSION:'2'} : {},
    durableObjects:{CALL_SIGNALING:{className:'CallSignalingHub',useSQLite:true},...(optimized?{SEROTINE_REALTIME:{className:'RelayRealtimeStore',useSQLite:true}}:{})}}
  let mf=new Miniflare(options)
  const clientBuild=esbuild.buildSync({absWorkingDir:sourceRoot,stdin:{contents:'export * from "./lib/request-auth.ts"; export * from "./lib/crypto.ts"; export {signGroup} from "./lib/messaging.ts"; export {callRoomId} from "./lib/call-room-protocol.ts";',resolveDir:sourceRoot},bundle:true,write:false,platform:'node',format:'cjs',target:'es2022'})
  const mod={exports:{}};new Function('module','exports','require',clientBuild.outputFiles[0].text)(mod,mod.exports,require); const client=mod.exports
  let now=Date.now();
  const tick=async(delta=0)=>{now+=delta;await mf.dispatchFetch(`https://serotine.example/__clock?now=${now}`)}
  const identity=async()=>{const keys=await client.generateEncryptionKeyPair();return {pair:keys,privateKey:await client.exportKey(keys.privateKey),publicKey:await client.exportPublicKeyToHex(keys.publicKey),sessionId:crypto.randomUUID()}}
  const request=async(person,action,data={},options={})=>{
    const payload=action.startsWith('call:')||action.startsWith('room:')?{sessionId:person.sessionId,...data}:data
    const proof=options.proof||await client.createRequestProof(action,payload,person.privateKey,person.publicKey,now)
    const body={version:action.startsWith('file:')||action.startsWith('call:')||action.startsWith('room:')?1:2,action,data:payload,proof}
    const route=action.startsWith('file:')?'files':action.startsWith('call:')||action.startsWith('room:')?'calls':'relay'
    const response=await mf.dispatchFetch(`https://serotine.example/api/${route}`, options.bytes ? {method:'PUT',headers:{'content-type':'application/octet-stream','x-serotine-file-request':JSON.stringify(body)},body:options.bytes} : {method:'POST',headers:{'content-type':'application/json',...(action.startsWith('event:')?{'x-serotine-events':'1'}:{})},body:JSON.stringify(body)})
    if(options.raw)return response
    const result=await response.json();assert.equal(result.success,true,`${action}: ${JSON.stringify(result)}`);return result
  }
  const metrics=async(reset=true)=>{const q=await mf.dispatchFetch(`https://serotine.example/__metrics${reset?'?reset':''}`);const bySql=await q.json();return {rowsWritten:Object.values(bySql).reduce((a,b)=>a+b,0),bySql:Object.fromEntries(Object.entries(bySql).filter(([,v])=>v))}}
  await tick()
  return {get mf(){return mf},async mode(value){await mf.dispatchFetch(`https://serotine.example/__mode?value=${value}`)},client,identity,request,tick,metrics,now:()=>now,async restart(){await mf.dispose();mf=new Miniflare(options);await tick()},async dispose(){await mf.dispose();fs.rmSync(persist,{recursive:true,force:true})}}
}
async function measure(sourceRoot=root,optimized=false){
 const h=await harness(sourceRoot,optimized)
 try{
  const a=await h.identity(),b=await h.identity(),linked={...b,sessionId:crypto.randomUUID()};const people=[a,b,linked]
  const cursors=new Map()
  const sync=async p=>{const feed=await h.request(p,'event:sync',{after:cursors.get(p.sessionId)||0});cursors.set(p.sessionId,feed.nextCursor);await h.request(p,'message:inbox')}
  const peers=p=>p===a?[b.publicKey]:[a.publicKey]
  const presence=async p=>{await h.request(p,'call:heartbeat',{peers:peers(p),incomingPeers:peers(p)});return h.request(p,'call:poll',{after:0})}
  // Warm schema/one-time setup separately. These are not steady-state writes.
  for(const p of people){await sync(p);await presence(p)}
  await h.request(a,'event:send',{id:crypto.randomUUID(),recipientPubKey:b.publicKey,encryptedData:'e'.repeat(120)})
  const setup=await h.metrics()
  const results={}
  let activeCallId
  for(const scenario of ['idle-10m','active-10m','call-10m']){
   if(scenario==='call-10m'){
    const callId=crypto.randomUUID();activeCallId=callId;const signal={id:crypto.randomUUID(),callId,sender:a.publicKey,recipient:b.publicKey,senderSession:a.sessionId,targetSession:null,expiresAt:h.now()+30_000,encryptedData:'e'.repeat(100)}
    await h.request(a,'call:invite',{signal,noHistory:false});await h.request(b,'call:claim',{callId,noHistory:false})
   }
   for(let step=0;step<120;step++){
    await h.tick(5000)
    for(const p of people){await sync(p);if(step%6===0){const snapshot=await presence(p);if(scenario==='call-10m'){assert.equal(snapshot.sessions.find(s=>s.callId===activeCallId)?.status,'active')}}}
    if(scenario==='active-10m'&&step%4===0){const sender=step%8===0?a:b;const recipient=sender===a?b:a;
     const message={id:crypto.randomUUID(),recipientPubKey:recipient.publicKey,encryptedData:'e'.repeat(256)}
     await h.request(sender,'event:send',message)
     if(step%12===0)await h.request(sender,'event:send',message) // fresh-proof delivery retry
    }
   }
   results[scenario]=await h.metrics()
  }
  await h.request(a,'call:finish',{callId:activeCallId,reason:'ended',noHistory:false})
  await h.metrics()
  const target={kind:'group',group:await h.client.signGroup({id:`group:${crypto.randomUUID()}`,name:'Workload group',admin:a.publicKey,members:[a.publicKey,b.publicKey],epoch:1,updatedAt:h.now()},a)}
  for(const p of [a,b])await h.request(p,'room:join',{target,mode:'voice',policy:'all'})
  for(let step=0;step<120;step++){
    await h.tick(5000)
    for(const p of people){await sync(p);if(step%6===0)await presence(p)}
    for(const p of [a,b]){const state=await h.request(p,'room:poll',{target,after:0});assert.equal(state.room.participants.length,2)}
  }
  results['room-10m']=await h.metrics()
  for(const p of [a,b])await h.request(p,'room:leave',{roomId:h.client.callRoomId(target)})
  await h.metrics()
  // An ordinary mixed session: 30 texts, a 1 MiB staged attachment, a legacy
  // inline attachment and repeated downloads/retries across linked devices.
  for(let step=0;step<120;step++){
    await h.tick(5000)
    for(const p of people){await sync(p);if(step%6===0)await presence(p)}
    if(step%4===0)await h.request(a,'event:send',{id:crypto.randomUUID(),recipientPubKey:b.publicKey,encryptedData:'m'.repeat(256)})
    if(step===12){
      const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex')
      const uploadId=crypto.randomUUID(),capability=await hash(new Uint8Array(32)),bytes=new Uint8Array(1024*1024+16)
      const accessHash=await hash(new TextEncoder().encode(capability))
      await h.request(a,'file:init',{uploadId,size:1024*1024,chunkCount:1,accessHash})
      const data={uploadId,index:0,size:bytes.byteLength,digest:await hash(bytes)}
      await h.request(a,'file:chunk',data,{bytes});await h.request(a,'file:chunk',data,{bytes})
      await h.request(a,'file:complete',{uploadId});await h.request(a,'file:publish',{uploadId})
      for(const p of [b,linked,b]){const response=await h.request(p,'file:read',{uploadId,index:0,capability},{raw:true});assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,bytes.byteLength)}
      await h.request(a,'event:send',{id:crypto.randomUUID(),recipientPubKey:b.publicKey,encryptedData:'manifest'.repeat(128)})
      await h.request(a,'message:send',{id:crypto.randomUUID(),recipientPubKey:b.publicKey,encryptedData:'legacy-attachment'.repeat(6000)})
    }
  }
  results['mixed-files-10m']=await h.metrics()
  return {baselineRef:'42f794ecc791bc9a11e9a79d7ecca77a76b6acc1',engine:'Miniflare/workerd D1 meta.rows_written',clients:3,setup,scenarios:results}
 }finally{await h.dispose()}
}
module.exports={harness,measure}
if(require.main===module)measure(process.argv.slice(2).find(x=>!x.startsWith('--'))||root,process.argv.includes('--optimized')).then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n')).catch(e=>{console.error(e);process.exitCode=1})
