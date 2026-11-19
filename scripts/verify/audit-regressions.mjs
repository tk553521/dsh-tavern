import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { LibraryStore } from '../../src/library.ts'
import { PrefsStore } from '../../src/prefs.ts'
import { TavernStorage } from '../../src/storage.ts'
import { AvatarStore } from '../../src/avatarstore.ts'
import { tavernHandler } from '../../src/api.ts'
import { normalizeConfig } from '../../src/config.ts'
import { normalizeCard, normalizeWorldBook, serializeCharacterCard, importChatJsonl } from '../../src/cardcodec.ts'
import { buildClassicSystem } from '../../src/prompt.ts'
import { activateBook, activateBooks } from '../../src/lorebook.ts'
import { importTauriTavernData } from '../../src/tauritavern.ts'
import { createLatestRequest } from '../../src/client/latest-request.ts'
import { TavernSessionRuntime } from '../../src/play.ts'
const logger = { warn() {}, error() {}, info() {} }
const play = { id:'play-a', characterIds:['char-a'], narratorEnabled:false, multiAgent:false }

test('classic supplement strips macros in character names', () => {
  const card = normalizeCard({ name:'{{unknown_macro}}', post_history_instructions:'Continue' })
  const prompt = buildClassicSystem(play, [{ id:'char-a', card }], '', undefined)
  assert.equal(prompt.includes('{{unknown_macro}}'), false)
})
for (const [logic, text, expected] of [[0,'dragon',0], [0,'dragon red',1], [1,'dragon red blue',0], [1,'dragon red',1], [2,'dragon red',0], [2,'dragon',1], [3,'dragon red',0], [3,'dragon red blue',1]]) {
  test(`regex primary honors selective ${logic} for ${text}`, () => {
    const book = normalizeWorldBook({ entries:[{ uid:1, key:[], keyregex:'dragon', keysecondary:['red','blue'], selective:true, selectiveLogic:logic, content:'payload' }] })
    assert.equal(activateBook(book, {text,turn:0,seed:1}).length, expected)
  })
}
test('same-priority multi-book render respects book order before entry index', () => {
  const make = contents => normalizeWorldBook({entries:contents.map((content,uid)=>({uid,constant:true,content,order:100}))})
  const entries = activateBooks([make(['A0','A1']),make(['B0'])], {text:'',turn:0,seed:1})
  assert.deepEqual(entries.map(x=>x.entry.content), ['A0','A1','B0'])
})
test('embedded legacy world-info fields survive character export', () => {
  const card = normalizeCard({ name:'A', character_book:{entries:[{uid:1,key:['dragon'],content:'x',depth:9,probability:13,ignoreBudget:true,keyregex:'dragon',extensions:{custom:'keep'}}]} })
  const restored = normalizeCard(serializeCharacterCard(card)).data.character_book.entries[0]
  assert.equal(restored.depth,9); assert.equal(restored.probability,13); assert.equal(restored.ignoreBudget,true)
  assert.equal(restored.keyregex,'dragon'); assert.equal(restored.extensions.custom,'keep')
})
test('JSONL non-object records do not abort subsequent valid chat messages', () => {
  const rows = importChatJsonl('null\n[]\n12\n{"name":"Alice","mes":"hello"}', ['Alice'])
  assert.equal(rows.length,1); assert.equal(rows[0].content,'hello')
})
test('bulk character persistence exposes failure and still saves other records', async () => {
  const root = await mkdtemp(join(tmpdir(),'tavern-batch-audit-'))
  try {
    const library = new LibraryStore(root,logger); await library.load()
    const put = library.putCharacter.bind(library)
    library.putCharacter = record => record.id === 'char-bad' ? Promise.reject(new Error('ENOSPC simulated')) : put(record)
    await assert.rejects(library.putCharacters([{id:'char-bad',card:normalizeCard({name:'Bad'})},{id:'char-good',card:normalizeCard({name:'Good'})}]), /persist|store|write/i)
    assert.ok(library.character('char-good')); assert.equal(library.character('char-bad'),undefined)
  } finally { await rm(root,{recursive:true,force:true}) } // verified mkdtemp fixture
})
test('Tauri importer reports only durable records and allows failed files to retry', async () => {
  const root = await mkdtemp(join(tmpdir(),'tavern-import-audit-'))
  try {
    const library = new LibraryStore(join(root,'library'),logger); await library.load()
    const prefs = new PrefsStore(join(root,'prefs.json'),logger); await prefs.load()
    const storage = new TavernStorage(library,prefs)
    const avatars = new AvatarStore(join(root,'avatars'),logger)
    const input = join(root,'default-user'); await mkdir(join(input,'characters'),{recursive:true})
    for (const name of ['Bad','Good']) await writeFile(join(input,'characters',`${name}.json`),JSON.stringify({name}))
    const put = library.putCharacter.bind(library)
    library.putCharacter = record => record.card.data.name === 'Bad' ? Promise.reject(new Error('ENOSPC simulated')) : put(record)
    const report = await importTauriTavernData(storage,avatars,input,{lorebooks:false,presets:false})
    assert.equal(report.imported.characters,1); assert.equal(report.issues.length,1)
    assert.equal(storage.listCharacters().length,1)
    library.putCharacter = put
    const retry = await importTauriTavernData(storage,avatars,input,{lorebooks:false,presets:false})
    assert.equal(retry.imported.characters,1); assert.equal(storage.listCharacters().length,2)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('avatar commit publishes new version before retiring old picture', async () => {
  await withApi(async (_base,{storage,avatars}) => {
    const old = await avatars.persistCharacter({id:'char-a',card:normalizeCard({name:'A'}),avatar:'data:image/png;base64,AQID'}, x=>storage.upsertCharacter(x),()=>storage.getCharacter('char-a'))
    const next = await avatars.persistCharacter({...old,avatar:'data:image/jpeg;base64,BAUG'}, x=>storage.upsertCharacter(x),()=>storage.getCharacter('char-a'))
    assert.notEqual(next.avatar,old.avatar)
    assert.deepEqual(await avatars.readCharacter(next),Buffer.from([4,5,6]))
    assert.equal(await avatars.readCharacter(old),undefined)
    assert.deepEqual(storage.getCharacter('char-a'),next)
  })
})
test('queued failed avatar save cannot delete preceding committed version', async () => {
  await withApi(async (_base,{storage,avatars}) => {
    const old = await avatars.persistCharacter({id:'char-a',card:normalizeCard({name:'A'}),avatar:'data:image/png;base64,AQID'}, x=>storage.upsertCharacter(x),()=>storage.getCharacter('char-a'))
    let release, entered
    const gate = new Promise(resolve=>{release=resolve}), started = new Promise(resolve=>{entered=resolve})
    const input = {...old,avatar:'data:image/png;base64,BAUG'}
    const first = avatars.persistCharacter(input,async x=>{entered();await gate;await storage.upsertCharacter(x)},()=>storage.getCharacter('char-a'))
    await started
    const second = avatars.persistCharacter(input,async()=>{throw new Error('ENOSPC simulated')},()=>storage.getCharacter('char-a'))
    const failed = assert.rejects(second,/ENOSPC/)
    release(); const next = await first; await failed
    assert.deepEqual(storage.getCharacter('char-a'),next)
    assert.deepEqual(await avatars.readCharacter(next),Buffer.from([4,5,6]))
  })
})

for (const restored of [false,true]) {
  test(`rc.3 reasoning effort reaches director and role ${restored ? 'resume' : 'create'}`, async () => {
    const options = [], fullPlay = {...play, sessionId:'director-a', multiAgent:true}, character = {id:'char-a',card:normalizeCard({name:'Alice'})}
    const factory = async opts => {
      options.push(opts)
      const events = []
      const agent = {id:opts.sessionId ?? opts.resumeSessionId,session:{snapshotEvents:()=>[...events]},followup(){},cancel(){},async whenIdle(){
        events.push({type:'assistant/message',data:{message:{content:[{type:'text',text:'new reply'}]}}})
        events.push({type:'turn/end',data:{reason:{kind:'completed'}}})
      }}
      return {agent,async dispose(){}}
    }
    const runtime = new TavernSessionRuntime({
      storage:{listPlays:()=>[fullPlay],getCharacter:()=>character,getPreset:()=>undefined,getLorebook:()=>undefined},
      agents:{create:factory,resume:factory},agentPresets:{},ensurePreset:async()=>{},workspace:()=>undefined,
      sessionPersistence:{async open(){
        if(!restored){const e=new Error('missing');e.name='SessionPersistenceNotFoundError';throw e}
        return {header:{},async read(){return {events:[]}},async close(){}}
      }},defaultModel:()=>({provider:'p',model:'m',reasoningEffort:'high'}),logger,config:normalizeConfig({}),
    })
    try {
      await runtime.ensureDirector(fullPlay)
      await runtime.speakFor({agent:{id:'director-a'},signal:new AbortController().signal},{})
      assert.equal(options.length,2)
      for(const opts of options) assert.equal(opts.agentOptions.reasoningEffort,'high')
    } finally {await runtime.dispose()}
  })
}

test('late snapshot and late error cannot replace a newer refresh', async () => {
  const jobs = [], published = []
  const gate = createLatestRequest(() => new Promise((resolve,reject)=>jobs.push({resolve,reject})), value=>published.push(value))
  const old = gate.run(), newer = gate.run()
  jobs[1].resolve('new'); await newer
  jobs[0].resolve('old'); await old
  assert.deepEqual(published,['new'])
  const staleError = gate.run(), newest = gate.run()
  jobs[3].resolve('newest'); await newest
  jobs[2].reject(new Error('obsolete error')); await staleError
  assert.deepEqual(published,['new','newest'])
  const cancelled = gate.run(); gate.invalidate(); jobs[4].resolve('unmounted'); await cancelled
  assert.deepEqual(published,['new','newest'])
  const liveError = gate.run(); jobs[5].reject(new Error('live error')); await assert.rejects(liveError,/live error/)
})

async function withApi(run) {
  const root = await mkdtemp(join(tmpdir(),'tavern-http-audit-'))
  const library = new LibraryStore(join(root,'library'),logger); await library.load()
  const prefs = new PrefsStore(join(root,'prefs.json'),logger); await prefs.load()
  const storage = new TavernStorage(library,prefs), avatars = new AvatarStore(join(root,'avatars'),logger)
  const server = createServer((req,res)=>void tavernHandler({storage,avatars,runtime:{},logger,config:normalizeConfig({}),multiAgentAvailable:()=>false},req,res))
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  try { await run(`http://127.0.0.1:${server.address().port}/tavern`,{library,storage,avatars}) }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}) }
}
test('HTTP malformed card and non-object bodies are 400, not 500', async () => {
  await withApi(async base => {
    for (const [route,method,body] of [['characters','POST','null'],['characters','POST','[]'],['characters','POST','{"card":{}}'],['characters','POST','{"input":"{}"}'],['settings','PUT','null']]) {
      const response = await fetch(`${base}/${route}`,{method,headers:{'content-type':'application/json'},body})
      assert.equal(response.status,400,`${route}: ${body}`); await response.text()
    }
  })
})
test('HTTP oversized JSON body receives 413 rather than a socket reset', async () => {
  await withApi(async base => {
    const response = await fetch(`${base}/characters`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(16*1024*1024+1)})
    assert.equal(response.status,413); assert.match((await response.json()).error,/MiB/)
  })
})
for (const mime of ['png','jpeg']) {
  test(`failed HTTP avatar update (${mime}) preserves original JSON and picture`, async () => {
    await withApi(async (base,{library,storage,avatars}) => {
      const original = await avatars.materializeCharacter({id:'char-a',card:normalizeCard({name:'Before'}),avatar:'data:image/png;base64,AQID',createdAt:'',updatedAt:''})
      await storage.upsertCharacter(original)
      library.putCharacter = async () => { throw new Error('ENOSPC simulated') }
      const response = await fetch(`${base}/characters/char-a`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({data:{name:'After'},avatar:`data:image/${mime};base64,BAUG`})})
      assert.equal(response.status,500); await response.text()
      assert.deepEqual(storage.getCharacter('char-a'),original)
      assert.deepEqual(await avatars.readCharacter(original),Buffer.from([1,2,3]))
    })
  })
}
