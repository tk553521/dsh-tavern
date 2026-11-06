// Verification of the greeting seed against the HOST's own session validator.
//
// `Session.create` validates a seed before any agent exists, so a seed the host
// rejects makes every new play fail at creation time — while the play record is
// rolled back, which is why the failure looks like "nothing happened". The DSH
// 0.2 session format made `assistant/message.data.stream` required and replaced
// the `plugin` message source with `user`, and both of those were missing here.
//
// This runs the plugin's real `greetingSeed()` (imported from source, not a
// copy) through the installed `@deepseek-ai/dsh-session`. Run with `npm run
// verify` (build first is not required for this file).
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { greetingSeed } from '../../src/play.ts'

const log = []
const check = (name, ok, extra = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

const id = SessionId('verify-seed')
const seed = greetingSeed('「你终于来了。」', 'verify', 'verify-model')

check('seed is four contiguous events', seed.length === 4, `events=${seed.length}`)
check('seed starts at seq 0 and has no gaps',
  seed.every((event, index) => event.seq === index), seed.map(event => event.seq).join(','))

let session
try {
  session = Session.create(id, seed, { version: 4, id, createdAt: Date.now(), isSeeded: false })
  check('the HOST accepts the seed (Session.create)', true)
} catch (error) {
  check('the HOST accepts the seed (Session.create)', false, String(error))
}

if (session !== undefined) {
  // The constructor appends its own `session/end-seed` marker, so the stored
  // log is the four seeded events plus that marker. Assert the marker rather
  // than merely counting: a host change to what it appends is information.
  const stored = session.snapshotEvents()
  check('the seed is stored losslessly and the seed boundary is marked',
    stored.length === 5 && stored[4]?.type === 'session/end-seed',
    stored.map(event => `${event.type}#${event.seq}`).join(' '))
  check('the surface carries both message nodes', session.surface.nodes.length === 2,
    `nodes=${session.surface.nodes.length}`)
  const projected = session.snapshotEvents()
    .map(event => deriveEventMessage(event))
    .filter(message => message !== null)
  check('both messages project for the model', projected.length === 2, `messages=${projected.length}`)
  const assistant = session.snapshotEvents().find(event => event.type === 'assistant/message')
  check('the greeting text survives projection',
    JSON.stringify(assistant?.data?.message?.content ?? []).includes('你终于来了'))
  const user = session.snapshotEvents().find(event => event.type === 'user/message')
  check('the seeded prompt uses a legal message source',
    user?.data?.source?.kind === 'user', String(user?.data?.source?.kind))
}

console.log(log.join('\n'))
