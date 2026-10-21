// Online smoke test (after `pnpm build:web`): starts the server serving dist/, opens two browsers,
// creates a room, joins it through the invite link, starts a 2v2 with open slots and checks that
// movement replicates and that a validated hit wins the round. Exit code 1 on any failure.
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const port = 8870 + Math.floor(Math.random() * 100)
const server = spawn(process.execPath, ['server/match/server.ts'], { env: { ...process.env, PORT: String(port) }, stdio: 'inherit' })
const url = `http://127.0.0.1:${port}/`
const fail = msg => {
  console.error(`online smoke: FAIL — ${msg}`)
  server.kill()
  process.exit(1)
}
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(url + 'health')).ok) break
  } catch {}
  await new Promise(r => setTimeout(r, 250))
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const errors = []
const open = async (tag, path = '') => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await ctx.addInitScript(() => localStorage.setItem('ironrift.save', JSON.stringify({ version: 1, quality: 'low' })))
  const p = await ctx.newPage()
  p.on('pageerror', e => errors.push(`${tag} ${e}`))
  p.on('response', r => r.status() >= 400 && errors.push(`${tag} ${r.status()} ${r.url()}`))
  await p.goto(url + path)
  return p
}
const info = p =>
  p.evaluate(() => {
    const g = window.__game.game
    const t = g.tactical
    return { phase: t.state.phase, alive: g.player.alive, score: t.state.score, enemies: t.enemies.filter(e => e.alive).map(e => ({ id: e.id, z: e.pos.z })) }
  })
try {
  const a = await open('A')
  await a.waitForFunction(() => document.body.dataset.screen === 'title', null, { timeout: 120000 })
  await a.click('.screen-title .btn:has-text("ONLINE")')
  await a.fill('.ol-name', 'Ana')
  await a.click('.screen-online .btn:has-text("CRIAR")')
  await a.waitForFunction(() => document.querySelector('.ol-code')?.textContent?.length === 5, null, { timeout: 15000 })
  const code = await a.textContent('.ol-code')
  const b = await open('B', `?sala=${code}`)
  await b.waitForFunction(() => document.body.dataset.screen === 'online', null, { timeout: 120000 })
  await b.fill('.ol-name', 'Bia')
  await b.click('.screen-online .btn:has-text("ENTRAR"):not(.ol-team-btn)')
  await b.waitForFunction(() => !document.querySelector('.ol-lobby').hidden, null, { timeout: 15000 })
  await b.click('.ol-ready-btn')
  await a.waitForFunction(() => !document.querySelector('.ol-start-btn').disabled, null, { timeout: 15000 })
  await a.click('.ol-start-btn')
  for (const p of [a, b]) await p.waitForFunction(() => window.__game.game.tactical?.net && document.body.dataset.screen === 'hud', null, { timeout: 30000 })
  // B moves; A must see the avatar follow.
  const z0 = (await info(a)).enemies[0]?.z
  if (z0 === undefined) fail('A does not see B')
  await b.evaluate(() => {
    const p = window.__game.game.player
    const to = { x: p.position.x, y: p.position.y + 0.9, z: p.position.z + 3 }
    p.body.setTranslation(to, true)
    p.body.setNextKinematicTranslation(to)
    p.position.z += 3
  })
  await a.waitForFunction(z => Math.abs(window.__game.game.tactical.enemies.find(e => e.alive).pos.z - z) > 1, z0, { timeout: 15000 }).catch(() => {})
  const z1 = (await info(a)).enemies[0].z
  if (Math.abs(z1 - z0) < 0.5) fail(`B's movement did not replicate (${z0} → ${z1})`)
  // Combat: A's hits are claims the server validates; B dies and A wins the round.
  await a.waitForFunction(() => window.__game.game.tactical.state.phase === 'combat', null, { timeout: 60000 })
  const target = (await info(a)).enemies[0].id
  for (let i = 0; i < 4; i += 1) {
    await a.evaluate(id => {
      const g = window.__game.game
      const e = g.tactical.enemies.find(x => x.id === id)
      g.damage(id, { attacker: 0, amount: 40, source: 'pistol', from: g.player.position.clone(), point: e.pos.clone() })
    }, target)
    await a.waitForTimeout(400)
  }
  await b.waitForTimeout(1500)
  const ra = await info(a)
  const rb = await info(b)
  if (rb.alive) fail('B survived the validated hits')
  if (ra.score[0] !== 1 || rb.score[1] !== 1) fail(`unexpected score A ${ra.score} B ${rb.score}`)
  if (errors.length) fail(errors.slice(0, 5).join('; '))
  console.log(`online smoke: OK — room ${code}, movement ${z0.toFixed(1)} → ${z1.toFixed(1)}, round won ${ra.score.join('-')}`)
} catch (e) {
  fail(String(e))
}
await browser.close()
server.kill()
process.exit(0)
