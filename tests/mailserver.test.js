import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MailServer } from '../src/mailserver.js'
import { buildToolDefinitions, createSeededFork } from '../src/api.js'
import { balancedLog, fakeCtx, fakeSession } from './helpers.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'agent-team-mail-'))
}

test('a posted message is visible to the addressed member and consumed once', async () => {
  const box = new MailServer({ sessionId: 's1', dir: await tempDir() })
  const message = await box.post({
    from: { childId: 'c-a', memberId: 'audit', generation: 0 },
    toMember: 'produce',
    body: 'the handler at a.ts:31 has no ownership check',
    topic: 'finding',
  })

  const first = await box.inbox({ reader: { childId: 'c-b1', memberId: 'produce', generation: 0 } })
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].id, message.id)
  assert.equal(first.messages[0].from.memberId, 'audit')

  const again = await box.inbox({ reader: { childId: 'c-b1', memberId: 'produce', generation: 0 } })
  assert.equal(again.messages.length, 0, 'a delivered message is gone from the mailbox')
})

test('an unread note to the previous generation reaches the next generation', async () => {
  const box = new MailServer({ sessionId: 's1', dir: await tempDir() })
  await box.post({
    from: { childId: 'c-a', memberId: 'audit', generation: 0 },
    toMember: 'reviewer',
    body: 'check the second handler too',
  })

  // Generation 0 never reads it.
  const next = await box.inbox({ reader: { childId: 'c-b2', memberId: 'reviewer', generation: 1 } })
  assert.equal(next.messages.length, 1, 'the note carries over to the next incarnation')
  assert.equal(next.messages[0].body, 'check the second handler too')
})

test('another member never sees a message addressed to someone else', async () => {
  const box = new MailServer({ sessionId: 's1', dir: await tempDir() })
  await box.post({ from: { childId: 'c-a', memberId: 'audit', generation: 0 }, toMember: 'produce', body: 'for produce only' })
  const other = await box.inbox({ reader: { childId: 'c-c', memberId: 'risk', generation: 0 } })
  assert.equal(other.messages.length, 0)
})

test('messages survive a new MailServer instance over the same file', async () => {
  const dir = await tempDir()
  const first = new MailServer({ sessionId: 's-same', dir })
  await first.post({ from: { childId: 'c-a', memberId: 'audit', generation: 0 }, toMember: 'reviewer', body: 'persisted' })
  const second = new MailServer({ sessionId: 's-same', dir })
  const inbox = await second.inbox({ reader: { childId: 'c-b', memberId: 'reviewer', generation: 0 } })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].body, 'persisted')
})

test('member tools resolve identities and exchange one message between members', async () => {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-mail', []) }
  const { ctx, sessions } = fakeCtx()
  sessions.set('parent-mail', parent.session)
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-mail' })
  const tools = new Map(buildToolDefinitions(() => api).map(definition => [definition.name, definition]))

  const first = await api.fork({ parent, memberId: 'audit', prompt: 'audit the handlers' })
  sessions.get(first.childId).events.push(...balancedLog(1, () => 'handler a.ts:31 is unguarded'))

  const roster = await tools.get('member_roster').execute({}, { agent: { session: { id: first.childId } } })
  assert.deepEqual(roster.members.map(member => member.member_id), ['orchestrator', 'audit'])
  assert.equal(roster.members[0].state, 'orchestrator')
  assert.equal(roster.members[1].state, 'idle')

  const posted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'confirm b.ts:88 as well', topic: 'follow-up' },
    { agent: { session: { id: first.childId } } },
  )
  assert.equal(posted.to_member, 'audit')

  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: first.childId } } })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].from_member, 'audit')
  assert.equal(inbox.messages[0].topic, 'follow-up')
  assert.equal(inbox.messages[0].body, 'confirm b.ts:88 as well')

  // The orchestrator has its own mailbox, not a global view.
  const oversight = await tools.get('member_inbox').execute({}, { agent: { session: { id: 'parent-mail' } } })
  assert.deepEqual(oversight.messages, [], 'the orchestrator cannot read mail addressed to a member')
})

test('a message from the orchestrator reaches the member', async () => {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-mail2', []) }
  const { ctx, sessions } = fakeCtx()
  sessions.set('parent-mail2', parent.session)
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-mail2' })
  const tools = new Map(buildToolDefinitions(() => api).map(definition => [definition.name, definition]))

  const member = await api.fork({ parent, memberId: 'produce', prompt: 'write the fix' })
  await tools.get('member_post').execute(
    { to_member: 'produce', body: 'audit says a.ts:31 is unguarded; verify before fixing' },
    { agent: { session: { id: 'parent-mail2' } } },
  )
  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: member.childId } } })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].from_member, 'orchestrator')
})

test('the child preamble names the member and is not duplicated', async () => {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-pre', []) }
  const { ctx, sessions, starts } = fakeCtx()
  sessions.set('parent-pre', parent.session)
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-pre' })

  await api.fork({ parent, memberId: 'audit', prompt: 'audit the handlers' })
  const prompt = starts[0].spec.request.prompt
  assert.match(prompt[0].text, /^\[member "audit"\]/u)
  assert.match(prompt[0].text, /member_inbox/u)
  assert.equal(prompt[1].text, 'audit the handlers', 'the task stays its own block after the preamble')

  await api.rotate({ parent, memberId: 'audit', prompt: 'go deeper' })
  const second = starts[1].spec.request.prompt
  assert.equal(second.filter(block => block.text?.startsWith('[member "')).length, 1)
  assert.match(second[0].text, /^\[member "audit"\]/u)
})

test('posting to an unknown member is rejected', async () => {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-mail3', []) }
  const { ctx, sessions } = fakeCtx()
  sessions.set('parent-mail3', parent.session)
  const api = createSeededFork(ctx, { directory: dir, providerName: 'p-mail3' })
  const tools = new Map(buildToolDefinitions(() => api).map(definition => [definition.name, definition]))

  await assert.rejects(
    () => tools.get('member_post').execute(
      { to_member: 'not-yet-started', body: 'read this first' },
      { agent: { session: { id: 'parent-mail3' } } },
    ),
    /unknown member "not-yet-started"/u,
  )

  const known = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  const accepted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'now it exists' },
    { agent: { session: { id: known.childId } } },
  )
  assert.equal(accepted.to_member, 'audit')


})

async function wakeSetup({ autoWake, mailRetry, deferResults = false } = {}) {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-wake', []) }
  const harness = fakeCtx({ deferResults })
  harness.sessions.set('parent-wake', parent.session)
  harness.ctx.agents = { get: id => (id === 'parent-wake' ? parent : undefined) }
  const api = createSeededFork(harness.ctx, {
    directory: dir,
    providerName: 'p-wake',
    ...(autoWake === undefined ? {} : { autoWake }),
    ...(mailRetry === undefined ? {} : { mailRetry }),
  })
  const tools = new Map(buildToolDefinitions(() => api).map(definition => [definition.name, definition]))
  return { ...harness, dir, parent, api, tools }
}

test('posting to a finished member starts its next generation so the message is read', async () => {
  const { parent, api, tools, starts } = await wakeSetup()
  const first = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await first.result
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await api.chain('audit'))[0].phase, 'settled')

  const posted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'one more finding to check' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(posted.wake, /started the next generation/u)
  const chain = await api.chain('audit')
  assert.equal(chain.length, 2, 'the wake created generation 1')
  assert.equal(chain[1].seedFrom, first.childId, 'the wake inherits the finished generation')
  // The wake's own task tells the new generation to read the mail.
  const wakePrompt = starts.at(-1).spec.request.prompt.map(block => block.text).join('\n')
  assert.match(wakePrompt, /member_inbox/u)
})

test('a running member is not woken again', async () => {
  const { parent, api, tools } = await wakeSetup({ deferResults: true })
  const first = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })

  const posted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'while you work' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(posted.wake, /still running/u)
  assert.equal((await api.chain('audit')).length, 1)
  first.activation.dispose()
})

test('the wake budget stops a message ping-pong', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: { maxPerMember: 1 } })
  await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await new Promise(resolve => setTimeout(resolve, 20))

  const firstPost = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'first nudge' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(firstPost.wake, /started the next generation/u)

  await new Promise(resolve => setTimeout(resolve, 20))
  const secondPost = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'second nudge' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(secondPost.wake, /budget-exhausted/u)
  assert.equal((await api.chain('audit')).length, 2, 'only the first post woke it')
})

test('autoWake:false disables the mechanism entirely', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await new Promise(resolve => setTimeout(resolve, 20))

  const posted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'nobody will read this' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(posted.wake, /disabled/u)
  assert.equal((await api.chain('audit')).length, 1)
})

test('without a live orchestrator the wake is reported instead of pretended', async () => {
  const dir = await tempDir()
  const parent = { session: fakeSession('parent-alone', []) }
  const harness = fakeCtx()
  harness.sessions.set('parent-alone', parent.session)
  const api = createSeededFork(harness.ctx, { directory: dir, providerName: 'p-alone' })
  const tools = new Map(buildToolDefinitions(() => api).map(definition => [definition.name, definition]))
  const first = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await first.result
  await new Promise(resolve => setTimeout(resolve, 20))

  const posted = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'no orchestrator to wake it' },
    { agent: { session: { id: 'parent-alone' } } },
  )
  assert.match(posted.wake, /orchestrator-not-live/u)
})

test('the inbox is point-to-point: a bystander member sees nothing', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const a = await api.fork({ parent, memberId: 'a', prompt: 'post something' })
  const b = await api.fork({ parent, memberId: 'b', prompt: 'wait for mail' })
  const c = await api.fork({ parent, memberId: 'c', prompt: 'also waiting' })

  await tools.get('member_post').execute(
    { to_member: 'b', body: 'only b should read this' },
    { agent: { session: { id: a.childId } } },
  )

  const asC = await tools.get('member_inbox').execute({}, { agent: { session: { id: c.childId } } })
  assert.deepEqual(asC.messages, [], 'c must not see mail addressed to b')

  const asB = await tools.get('member_inbox').execute({}, { agent: { session: { id: b.childId } } })
  assert.equal(asB.messages.length, 1)
  assert.equal(asB.messages[0].body, 'only b should read this')

  const asA = await tools.get('member_inbox').execute({}, { agent: { session: { id: a.childId } } })
  assert.deepEqual(asA.messages, [], 'the sender does not see its own outgoing message')
})

test('a child this plugin never reserved cannot read the mail store', async () => {
  const { parent, api, tools, sessions } = await wakeSetup({ autoWake: false })
  const member = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'member-only mail' },
    { agent: { session: { id: 'parent-wake' } } },
  )

  const foreign = fakeSession('foreign-child', [])
  foreign.header = { origin: 'subagent', parentSession: 'parent-wake' }
  sessions.set('foreign-child', foreign)
  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: 'foreign-child' } } })
  assert.deepEqual(inbox.messages, [], 'a non-member child gets an empty inbox, not the whole store')
})

test('a member can leave a message for the orchestrator, and only it reads it', async () => {
  // Default autoWake: posting to the orchestrator address must not try to
  // reincarnate anything, and must say so.
  const { parent, api, tools } = await wakeSetup()
  const a = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })

  const posted = await tools.get('member_post').execute(
    { to_member: 'orchestrator', body: 'found an unguarded handler at a.ts:31', topic: 'finding' },
    { agent: { session: { id: a.childId } } },
  )
  assert.equal(posted.warning, undefined, 'the orchestrator address is always known')
  assert.match(posted.wake, /orchestrator/u)

  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].from_member, 'audit')
  assert.equal(inbox.messages[0].body, 'found an unguarded handler at a.ts:31')

  // Another member never sees mail addressed to the orchestrator.
  const b = await api.fork({ parent, memberId: 'produce', prompt: 'produce' })
  const other = await tools.get('member_inbox').execute({}, { agent: { session: { id: b.childId } } })
  assert.deepEqual(other.messages, [])
})

test('the store lives in one .mail.json file per orchestrator session', async () => {
  const dir = await tempDir()
  const box = new MailServer({ sessionId: 'session-abc', dir })
  assert.match(box.filePath.replaceAll('\\', '/'), /\/session-abc\.mail\.json$/u)
  await box.post({ from: { childId: 'c-a', memberId: 'audit', generation: 0 }, toMember: 'orchestrator', body: 'finding' })
  const files = await (await import('node:fs/promises')).readdir(dir)
  assert.deepEqual(files, ['session-abc.mail.json'])
})

test('mailbox counts include mail addressed to others, without exposing it', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const a = await api.fork({ parent, memberId: 'a', prompt: 'a' })
  const b = await api.fork({ parent, memberId: 'b', prompt: 'b' })

  await tools.get('member_post').execute(
    { to_member: 'orchestrator', body: 'for the orchestrator only' },
    { agent: { session: { id: a.childId } } },
  )
  await tools.get('member_post').execute(
    { to_member: 'b', body: 'a message for b' },
    { agent: { session: { id: a.childId } } },
  )

  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(inbox.messages.length, 1, 'the orchestrator reads only its own mail')
  assert.equal(inbox.unread, 1, 'the delivered message is gone; only the other member mail remains')
  assert.equal(inbox.unread_yours, 0, 'its own message was consumed by this read')
  assert.equal(inbox.unread_others, 1, 'the other member still has unread mail')
})

test('member_dispatch starts a generation from the mail and leases it', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  const produce = await api.fork({ parent, memberId: 'produce', prompt: 'produce' })
  await produce.result
  await new Promise(resolve => setTimeout(resolve, 20))

  await tools.get('member_post').execute(
    { to_member: 'produce', body: 'the handler at a.ts:31 is unguarded', topic: 'finding' },
    { agent: { session: { id: audit.childId } } },
  )

  const first = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(first.dispatched.length, 1)
  assert.equal(first.dispatched[0].member_id, 'produce')
  assert.equal(first.dispatched[0].messages, 1)
  assert.equal(first.dispatched[0].state, 'started')
})

test('member_dispatch leaves a running member to its own inbox', async () => {
  const { parent, api, tools } = await wakeSetup({ deferResults: true, autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  const produce = await api.fork({ parent, memberId: 'produce', prompt: 'produce' })

  await tools.get('member_post').execute(
    { to_member: 'produce', body: 'while you work' },
    { agent: { session: { id: audit.childId } } },
  )
  const result = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.deepEqual(result.dispatched, [])
  assert.equal(result.skipped[0].member_id, 'produce')
  assert.match(result.skipped[0].reason, /already running/u)
  produce.activation.dispose()
})

test('member_dispatch is reserved for the orchestrator', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await assert.rejects(
    () => tools.get('member_dispatch').execute({}, { agent: { session: { id: audit.childId } } }),
    /reserved for the orchestrator/u,
  )
})

test('a settled member appends the mailbox notice to the parent session', async () => {
  const harness = await wakeSetup({ autoWake: false })
  const { parent, api } = harness
  const tools = harness.tools
  /** @type {Array<{ type: string, message: any }>} */
  const appended = []
  parent.session.append = (type, message) => { appended.push({ type, message }) }

  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  // Mail for the orchestrator that is still unread when audit settles.
  await tools.get('member_post').execute(
    { to_member: 'orchestrator', body: 'audit found an unguarded handler' },
    { agent: { session: { id: audit.childId } } },
  )
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(appended.length, 1, 'one notice per settlement with mail on the server')
  assert.equal(appended[0].type, 'user/message')
  assert.equal(appended[0].message.source.form, 'snapshot')
  assert.match(appended[0].message.content[0].text, /mailbox server holds 1 message/u)
  assert.match(appended[0].message.content[0].text, /member_dispatch/u)
})

test('the member preamble names the peers it may talk to', async () => {
  const { parent, api, starts } = await wakeSetup({ autoWake: false })
  await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await api.fork({ parent, memberId: 'produce', prompt: 'produce' })
  await api.fork({ parent, memberId: 'review', prompt: 'review' })

  const latest = starts.at(-1).spec.request.prompt[0].text
  assert.match(latest, /Teammates in this orchestration:/u)
  assert.match(latest, /"audit"/u)
  assert.match(latest, /"produce"/u)
  const blocks = latest.split('Talk to a teammate directly')
  assert.doesNotMatch(blocks[0], /^- "review"/mu, 'a member is not its own teammate')
  assert.match(latest, /report to "orchestrator"/u)
})

test('declared peer links reach the member, and a rotation keeps them', async () => {
  const { parent, api, starts } = await wakeSetup({ autoWake: false })
  const peers = [
    { member: 'ground', relationship: 'owns the code facts you audit', when: 'as soon as a fact you need is missing' },
    { member: 'produce', relationship: 'applies your fixes', when: 'once a defect is confirmed' },
  ]
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit', peers, reportWhen: 'report on scope conflicts only' })

  const declared = starts.at(-1).spec.request.prompt[0].text
  assert.match(declared, /"ground" — owns the code facts you audit/u)
  assert.match(declared, /as soon as a fact you need is missing/u)
  assert.match(declared, /"produce" — applies your fixes/u)
  assert.match(declared, /report on scope conflicts only/u)

  await audit.result
  await new Promise(resolve => setTimeout(resolve, 20))
  await api.rotate({ parent, memberId: 'audit', prompt: 'go deeper' })

  const inherited = starts.at(-1).spec.request.prompt[0].text
  assert.match(inherited, /- "ground" — owns the code facts you audit\./u, 'rotation inherits the declared links')
  assert.match(inherited, /report on scope conflicts only/u)
})

test('the journal carries the declared links', async () => {
  const { parent, api } = await wakeSetup({ autoWake: false })
  const peers = [{ member: 'ground', relationship: 'owns the facts', when: 'when a fact is missing' }]
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit', peers, reportWhen: 'on scope only' })
  const entry = await api.journalForSession('parent-wake').entryOf(audit.childId)
  assert.deepEqual(entry.peers, peers)
  assert.equal(entry.reportWhen, 'on scope only')
})

test('mail whose generation finished without reading is handed to the next one', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  const produce = await api.fork({ parent, memberId: 'produce', prompt: 'produce' })
  await produce.result
  await new Promise(resolve => setTimeout(resolve, 20))

  await tools.get('member_post').execute(
    { to_member: 'produce', body: 'a.ts:31 is unguarded', topic: 'finding' },
    { agent: { session: { id: audit.childId } } },
  )

  const first = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(first.dispatched.length, 1)
  await new Promise(resolve => setTimeout(resolve, 30))

  // The dispatched generation ended without reading, so the mail is still unread.
  const second = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(second.dispatched.length, 1, 'an expired lease is re-dispatched')
  
})

test('mail addressed to a member that does not exist yet creates that member', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  // Mail that reached the store without a member behind it (written before this
  // rule, or by another tool) still gets a member on demand.
  await api.mailServerForSession('parent-wake').post({
    from: { childId: 'legacy', memberId: 'orchestrator', generation: 0 },
    toMember: 'review',
    body: 'start by reading the config',
  })
  const result = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(result.dispatched.length, 1)
  assert.equal(result.dispatched[0].member_id, 'review')
  assert.equal(result.dispatched[0].state, 'started', 'the member is created on demand')
  assert.equal((await api.chain('review')).length, 1)
})

test('mail that cannot get a generation is reported as stuck, not swallowed', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  // Exhaust the cap so no further generation can start for this member.
  const journal = api.journalForSession('parent-wake')
  for (let i = 0; i < 40; i += 1) {
    try { await journal.reserve({ memberId: 'audit' }) } catch { break }
  }

  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'nobody can read this' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  const result = await tools.get('member_dispatch').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(result.dispatched.length, 0)
  assert.equal(result.stuck.length, 1)
  assert.match(result.stuck[0].reason, /cap/u)
  assert.equal(result.stuck[0].messages, 1, 'the message is still counted as unread work')
})

test('a wake that could not start releases its lock', async () => {
  const { parent, api, tools } = await wakeSetup()
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 20))

  const first = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'first' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(first.wake, /started the next generation/u)
  await new Promise(resolve => setTimeout(resolve, 30))

  const second = await tools.get('member_post').execute(
    { to_member: 'audit', body: 'second' },
    { agent: { session: { id: 'parent-wake' } } },
  )
  assert.match(second.wake, /started the next generation/u, 'the lock was released after the first wake')
})

test('a generation that ends with unread mail starts the next one by itself', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  // Mail lands while audit is still running, so it settles with it unread.
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'check c.ts:12 as well' },
    { agent: { session: { id: audit.childId } } },
  )
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 60))

  const chain = await api.chain('audit')
  assert.equal(chain.length, 2, 'the unread mail started generation 1')
  assert.equal(chain[1].seedFrom, audit.childId)
  const journal = api.journalForSession('parent-wake')
  const count = await journal.autoWakeCount('audit', 'unread-mail-retry')
  assert.equal(count, 1, 'the retry is recorded with its own reason')
})

test('the retry budget stops a member that keeps ignoring its inbox', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false, mailRetry: { maxPerMember: 1 } })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'first' },
    { agent: { session: { id: audit.childId } } },
  )
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 60))
  const afterFirst = (await api.chain('audit')).length
  assert.equal(afterFirst, 2)

  // Gen 1 also ends without reading, but the budget is spent.
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal((await api.chain('audit')).length, 2, 'no further retry once the budget is spent')
})

test('a generation that read its mail is not retried', async () => {
  const { parent, api, tools, starts } = await wakeSetup({ autoWake: false, deferResults: true })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'handled properly' },
    { agent: { session: { id: audit.childId } } },
  )
  // Read it before the generation settles, which is what the preamble asks for.
  await tools.get('member_inbox').execute({}, { agent: { session: { id: audit.childId } } })
  starts.at(-1).settle('completed')
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal((await api.chain('audit')).length, 1, 'read mail needs no new generation')
})

test('a delivered message does not reappear in the next incarnation', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'the handler at a.ts:31 is unguarded' },
    { agent: { session: { id: audit.childId } } },
  )
  // Generation 0 reads and acknowledges it.
  await tools.get('member_inbox').execute({}, { agent: { session: { id: audit.childId } } })
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 30))

  // Reading delivers: the message is gone, so the next incarnation starts clean.
  const next = await api.rotate({ parent, memberId: 'audit', prompt: 'continue' })
  const inbox = await tools.get('member_inbox').execute({}, { agent: { session: { id: next.childId } } })
  assert.equal(inbox.messages.length, 0, 'a delivered message does not reappear')
  assert.equal(inbox.unread, 0)
})

test('an unreadable store is set aside instead of being overwritten empty', async () => {
  const { readFile, writeFile, readdir } = await import('node:fs/promises')
  const { MailServer } = await import('../src/mailserver.js')
  const dir = await mkdtemp(join(tmpdir(), 'agent-team-corrupt-'))
  const box = new MailServer({ sessionId: 's-corrupt', dir })
  await writeFile(box.filePath, '{ this is not json', 'utf8')
  const fresh = new MailServer({ sessionId: 's-corrupt', dir })
  await fresh.post({ from: { childId: 'c1', memberId: 'a', generation: 0 }, toMember: 'b', body: 'new mail' })
  const files = await readdir(dir)
  const quarantined = files.filter(file => file.includes('.corrupt-'))
  assert.equal(quarantined.length, 1, 'the unreadable bytes were kept')
  assert.match(await readFile(join(dir, quarantined[0]), 'utf8'), /this is not json/u)
  const stored = JSON.parse(await readFile(fresh.filePath, 'utf8'))
  assert.equal(stored.messages.length, 1)
})

test('a member is never told to dispatch', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const a = await api.fork({ parent, memberId: 'a', prompt: 'a' })
  const b = await api.fork({ parent, memberId: 'b', prompt: 'b' })
  await tools.get('member_post').execute(
    { to_member: 'b', body: 'for b only' },
    { agent: { session: { id: a.childId } } },
  )

  const asMember = await tools.get('member_inbox').execute({}, { agent: { session: { id: a.childId } } })
  assert.equal(asMember.role, 'member')
  const rendered = tools.get('member_inbox').output.render({}, asMember)[0].text
  assert.doesNotMatch(rendered, /member_dispatch/u, 'a member must not be told to dispatch')
  assert.match(rendered, /addressed to others/u)

  const asOrchestrator = await tools.get('member_inbox').execute({}, { agent: { session: { id: 'parent-wake' } } })
  assert.equal(asOrchestrator.role, 'orchestrator')
  const orchestratorView = tools.get('member_inbox').output.render({}, asOrchestrator)[0].text
  assert.match(orchestratorView, /member_dispatch/u, 'the orchestrator still gets the dispatch rule')
})

test('the settlement notice only tells the orchestrator to dispatch', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'the handler is unguarded' },
    { agent: { session: { id: audit.childId } } },
  )
  await audit.result
  await new Promise(resolve => setTimeout(resolve, 40))

  // The orchestrator's session gets the notice and the dispatch rule; a member
  // session would get the same notice without that rule.
  const { buildMailboxNotice, noticeText } = await import('../src/mailbox-notice.js')
  assert.match(noticeText({ total: 2, yours: 1, others: 1, role: 'orchestrator' }), /member_dispatch/u)
  assert.doesNotMatch(noticeText({ total: 2, yours: 1, others: 1, role: 'member' }), /member_dispatch/u)
  assert.match(buildMailboxNotice({ total: 2, yours: 1, others: 1, role: 'member' }).content[0].text, /member_inbox/u)
})

test('reading removes the message from the mailbox', async () => {
  const { parent, api, tools } = await wakeSetup({ autoWake: false })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'handled now' },
    { agent: { session: { id: audit.childId } } },
  )

  const before = await tools.get('member_inbox').execute({ ack: false }, { agent: { session: { id: audit.childId } } })
  assert.equal(before.unread, 1)
  const rendered = tools.get('member_inbox').output.render({}, before)[0].text
  assert.match(rendered, /1 unread \(1 yours, 0 addressed to others\)/u)

  const read = await tools.get('member_inbox').execute({}, { agent: { session: { id: audit.childId } } })
  assert.equal(read.messages.length, 1, 'the read returned it')
  assert.equal(read.unread, 0, 'and the mailbox is empty afterwards')
  const after = tools.get('member_inbox').output.render({}, read)[0].text
  assert.match(after, /mailbox: empty/u)
  assert.doesNotMatch(after, /member_dispatch/u)
})

test('a failed generation is left to the orchestrator, not auto-restarted', async () => {
  const { parent, api, tools, starts } = await wakeSetup({ autoWake: false, deferResults: true })
  const audit = await api.fork({ parent, memberId: 'audit', prompt: 'audit' })
  await tools.get('member_post').execute(
    { to_member: 'audit', body: 'never read, the child died first' },
    { agent: { session: { id: audit.childId } } },
  )
  starts.at(-1).fail(new Error('provider exploded'))
  await assert.rejects(() => audit.result)

  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal((await api.chain('audit')).length, 1, 'no replacement generation was started')
  const journal = api.journalForSession('parent-wake')
  assert.equal(await journal.autoWakeCount('audit', 'unread-mail-retry'), 0)
  const entry = await journal.entryOf(audit.childId)
  assert.equal(entry.phase, 'failed', 'the failure is recorded for the orchestrator to see')
})
