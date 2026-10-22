import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import type { Game, GameMode } from './game/game'
import { Ui } from './ui/ui'
import { NetClient } from './net/client'
import { NetLink } from './net/link'
import { isRoomCode, type OnlineMapId } from './net/protocol'
import type { MapId } from './game/maps'
import { createLeaderboardClient, type LeaderboardClient, type Result, type RunTicket } from '../leaderboard.js'

/**
 * Boot flow (staged streaming):
 *  1. The loading screen (with its painted backdrop) shows immediately.
 *  2. Code, Rapier WASM, the arena library and Stage 1 (rifle, shotgun, robot rig, VFX atlases,
 *     core SFX) load in parallel — exactly what the title screen and Wave 1 need.
 *  3. Title screen appears. Stages 2–4 (drones, heavies, boss) stream in the background one file at
 *     a time, pausing whenever combat heats up (many enemies/particles or rising frame time).
 *     Before a wave needs a stage, the game calls ensure(), which jumps it to the front.
 */
async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  const i18n = new I18n()
  const input = new Input(canvas)
  const audio = new Audio()
  const leaderboard: LeaderboardClient = createLeaderboardClient({ identity: 'guest', boardId: 'riftstrike-frags-v1', rulesVersion: 'v1' })
  let game: Game | undefined
  let rankedRun: Promise<Result<RunTicket>> | null = null
  let lockLostAt = 0
  const applySettings = (d: SaveData) => {
    input.sensitivity = d.sensitivity
    input.invertY = d.invertY
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) {
      game.reducedMotion = d.reducedMotion
      game.fovSetting = d.fov
    }
  }
  /** Map picked on the MAPAS screen (practice deathmatch); null for the normal modes. */
  let practiceMap: MapId | null = null
  const startMatch = (mode?: GameMode) => {
    if (!game) return
    const selectedMode = mode ?? game.gameMode
    game.teamSize = save.data.teamSize
    closeBuy(false)
    audio.unlock()
    audio.retryMusic()
    ui.resetHud()
    game.start(selectedMode, null, practiceMap)
    ui.setMap(game.arena.minimap, game.arena.sites, game.minimapFrame())
    rankedRun = selectedMode === 'deathmatch' && !practiceMap
      ? (async (): Promise<Result<RunTicket>> => {
          const guest = await leaderboard.ensureGuest('RiftRunner')
          if (!guest.ok) return guest
          return leaderboard.beginRun()
        })()
      : null
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }
  // Tactical shop: frees the cursor while open; closing re-captures it when the round is live.
  const openBuy = () => {
    if (!game?.tactical?.canBuy || ui.tac.buyOpen) return
    ui.tac.setBuyOpen(true)
    input.unlockPointer()
  }
  const closeBuy = (relock = true) => {
    if (!ui.tac.buyOpen) return
    ui.tac.setBuyOpen(false)
    if (relock && game?.mode === 'playing' && game.player.alive) input.lockPointer()
  }
  const pause = () => {
    if (ui.tac.buyOpen) return closeBuy()
    if (game?.mode !== 'playing' && game?.mode !== 'countdown') return
    // Online the match keeps running for everyone: the menu opens over the live game.
    if (onlineMatch) {
      if (ui.screen === 'hud') ui.show('pause')
      input.unlockPointer()
      return
    }
    if (game.choosingPerk) return
    game.pause()
    ui.show('pause')
    input.unlockPointer()
  }
  const resume = () => {
    if (onlineMatch && ui.screen === 'pause') {
      ui.show('hud')
      if (game?.mode === 'playing') input.lockPointer()
      return
    }
    if (game?.mode !== 'paused') return
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
    if (!game.choosingPerk) input.lockPointer()
  }
  const pickPerk = (i: number) => {
    if (!game?.choosingPerk) return
    game.choosePerk(i)
    if (game.mode === 'playing') input.lockPointer()
  }
  // ─── online ───────────────────────────────────────────────────────────
  // The match server normally lives on the same origin (one Render web service serves both);
  // VITE_SERVER_URL points the client at a separate server instead.
  const serverUrl = (): string => {
    const env = import.meta.env.VITE_SERVER_URL as string | undefined
    if (env) return env
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  }
  let net: NetClient | null = null
  let netMe = ''
  let netStart: { you: string; roster: string[]; map: OnlineMapId } | null = null
  let onlineMatch = false
  let ids = { ally0: 201, enemy0: 211 }
  const disconnect = () => {
    if (net) {
      net.send({ t: 'leave' })
      net.close()
    }
    net = null
    netStart = null
  }
  /** Leave the online match (results screen or quit) and go back to the online menu or the title. */
  const endOnline = (to: 'online' | 'title') => {
    onlineMatch = false
    disconnect()
    game?.toTitle()
    ui.resetHud()
    ui.online.reset()
    ui.show(to)
    input.unlockPointer()
  }
  const connectionLost = () => {
    net = null
    netStart = null
    if (onlineMatch) endOnline('online')
    else ui.online.reset()
    ui.online.status('A conexão com o servidor caiu. Tente de novo.', 'warn')
  }
  const startOnline = (link: NetLink) => {
    if (!game) return
    onlineMatch = true
    closeBuy(false)
    audio.unlock()
    audio.retryMusic()
    ui.resetHud()
    rankedRun = null
    game.start('tactical', link)
    ui.setMap(game.arena.minimap, game.arena.sites, game.minimapFrame())
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }
  const connect = async (name: string): Promise<NetClient | null> => {
    if (net?.connected) return net
    const c = new NetClient()
    ui.online.setBusy(true, 'Conectando ao servidor…')
    try {
      netMe = await c.connect(serverUrl(), name)
    } catch (e) {
      ui.online.setBusy(false)
      const why = (e as Error).message
      ui.online.status(why === 'version' ? 'Seu jogo está desatualizado: recarregue a página.' : 'Não foi possível conectar ao servidor online neste endereço.', 'warn')
      return null
    }
    net = c
    c.on('lobby', m => {
      if (!onlineMatch) ui.online.showLobby(m.lobby, netMe)
    })
    c.on('error', m => {
      if (m.code === 'closed') return connectionLost()
      ui.online.setBusy(false)
      ui.online.status(m.message, 'warn')
    })
    c.on('matchStart', m => {
      netStart = { you: m.you, roster: m.roster, map: m.map }
    })
    // The first full state after matchStart starts the match; later ones go to the director.
    c.on('state', m => {
      if (!netStart || onlineMatch || !game) return
      startOnline(new NetLink(c, netStart, m, ids.ally0, ids.enemy0))
    })
    return c
  }

  const ui = new Ui(i18n, save, audio, {
    play: mode => {
      practiceMap = null
      startMatch(mode)
    },
    playMap: map => {
      practiceMap = map
      startMatch('deathmatch')
    },
    restart: () => (onlineMatch ? endOnline('online') : startMatch()),
    resume,
    quit: () => {
      if (onlineMatch) return endOnline('title')
      game?.toTitle()
      ui.resetHud()
      ui.show('title')
      input.unlockPointer()
    },
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (qualityChanged && game) {
        game.renderer.applyQuality(save.data.quality)
        game.setQuality()
      }
    },
    pickPerk,
    buy: item => (game?.tactical?.canBuy ? game.tactical.buy(item) : null),
    closeBuy: () => closeBuy(),
    online: {
      create: (name, teamSize) => void connect(name).then(c => c?.send({ t: 'create', teamSize })),
      join: (name, code) => void connect(name).then(c => c?.send({ t: 'join', code })),
      team: team => net?.send({ t: 'team', team }),
      ready: ready => net?.send({ t: 'ready', ready }),
      fillBots: on => net?.send({ t: 'fillBots', on }),
      start: () => net?.send({ t: 'start' }),
      map: map => net?.send({ t: 'map', map }),
      leave: disconnect,
    },
  })
  ui.show('boot')
  // Invite links (?sala=ABCDE) open the online screen with the code filled in.
  const invite = new URLSearchParams(location.search).get('sala')?.toUpperCase() ?? ''
  if (isRoomCode(invite)) ui.online.prefill(invite)
  applySettings(save.data)
  // Keep the spark layer and loading tips alive while the heavy modules download.
  let bootRaf = 0
  let bootLast = performance.now()
  const bootTick = (now: number) => {
    ui.tick(Math.min(0.05, (now - bootLast) / 1000))
    bootLast = now
    bootRaf = requestAnimationFrame(bootTick)
  }
  bootRaf = requestAnimationFrame(bootTick)

  const parts = { code: 0, library: 0, stage: 0 }
  const progress = (label?: string) => ui.setBootProgress(0.04 + parts.code * 0.16 + parts.library * 0.5 + parts.stage * 0.3, label)
  progress('INITIALISING RIFT')
  const [{ Game }, { Renderer, suggestQuality }, physics, { Assets }, { loadLibrary }, { StageLoader }, { ALLY_ID0, ENEMY_ID0 }] = await Promise.all([
    import('./game/game'),
    import('./engine/renderer'),
    import('./engine/physics'),
    import('./engine/assets'),
    import('./game/library'),
    import('./game/stages'),
    import('./game/tacticalMatch'),
    document.fonts.ready,
  ])
  ids = { ally0: ALLY_ID0, enemy0: ENEMY_ID0 }
  await physics.initPhysics()
  parts.code = 1
  progress('BUILDING ARENA')
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }
  const renderer = new Renderer(canvas, save.data.quality)
  const assets = new Assets()
  const aniso = renderer.gl.capabilities.getMaxAnisotropy()
  const loader = new StageLoader(assets, audio, aniso)
  const [lib] = await Promise.all([
    loadLibrary(assets, aniso, p => {
      parts.library = p
      progress()
    }),
    loader.boot(p => {
      parts.stage = p
      progress(p < 1 ? 'ARMING WAVE 1' : undefined)
    }),
  ])
  progress('CALIBRATING OPTICS')
  game = new Game(renderer, input, audio, lib, loader.staged, loader, {
    ...ui.events,
    perks: offer => {
      ui.events.perks(offer)
      // Free the cursor so the perk cards can be clicked; re-lock after the pick.
      if (offer) input.unlockPointer()
    },
    perkChosen: i => ui.perkChosen(i),
    closeBuy: () => closeBuy(),
    ended: (match, summary) => {
      input.unlockPointer()
      ui.tacBoard = game!.tactical?.scoreboard() ?? []
      ui.showResults(match, game!.standings(), summary)
      // Only Deathmatch scores enter the casual frags board. Local results remain independent of
      // the network: failures are rendered in the result panel and never interrupt the match.
      if (!summary && game!.gameMode === 'deathmatch' && !match.unranked) {
        if (!rankedRun) {
          ui.setOnlineStatus('Placar online indisponível nesta partida.', 'warn')
        } else {
          void rankedRun.then(async issued => {
            if (!issued.ok) {
              ui.setOnlineStatus(`Erro no placar online: ${issued.error}`, 'warn')
              return
            }
            const sent = await leaderboard.submitRun(issued.value, match.score, Math.max(0, Math.round(match.elapsed * 1000)))
            if (!sent.ok) {
              ui.setOnlineStatus(`Erro no placar online: ${sent.error}`, 'warn')
              return
            }
            ui.setOnlineStatus(sent.value.leaderboard.ok ? 'Pontuação enviada ao placar online.' : `Pontuação enviada; atualização indisponível: ${sent.value.leaderboard.error}`, sent.value.leaderboard.ok ? 'good' : 'warn')
          })
        }
      }
    },
  })
  applySettings(save.data)
  ui.setMap(game.arena.minimap, game.arena.sites)
  const g = game
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([import('../scripts/manus-tuning/adapter.js'), import('./game/tuning')])
    await registerGameTuning(tuning)
  }
  // Warm up shaders for every material present so the first explosion does not hitch.
  renderer.gl.compile(g.scene, g.camera)

  // Background streaming waits while the fight is heavy (enemy/VFX counts or slow frames).
  let frameAvg = 16
  loader.isBusy = () => g.isBusy() || frameAvg > 21 || document.hidden
  const loop = new GameLoop({
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      frameAvg += (Math.min(0.1, frameSeconds) * 1000 - frameAvg) * 0.05
      // Real frame time drives the VFX budget (bulk emitters shed particles when frames run long).
      g.fx.frameTime(frameSeconds * 1000)
      if (g.mode === 'playing' || g.mode === 'countdown') g.renderer.adapt(frameSeconds * 1000)
      input.update()
      if (g.tactical && input.consume('buy')) {
        if (ui.tac.buyOpen) closeBuy()
        else openBuy()
      }
      if (input.consume('pause') && performance.now() - lockLostAt > 300) {
        if ((g.mode === 'playing' || g.mode === 'countdown') && ui.screen !== 'pause') pause()
        else if ((g.mode === 'paused' || onlineMatch) && ui.screen === 'pause') resume()
      }
      // Keyboard perk selection (1–3) while the perk cards are up.
      if (g.choosingPerk) {
        if (input.consume('slot1')) pickPerk(0)
        else if (input.consume('slot2')) pickPerk(1)
        else if (input.consume('slot3')) pickPerk(2)
      }
      g.render(alpha, frameSeconds)
      ui.tick(frameSeconds)
      ui.fps(frameSeconds, save.data.showFps)
      if (g.mode === 'playing' || g.mode === 'countdown' || g.mode === 'ended' || g.mode === 'paused') {
        const pxPerRad = window.innerHeight / 2 / Math.tan((g.camera.fov * Math.PI) / 360)
        const board = input.held('scoreboard')
        const extra = g.tactical ? { minimap: g.minimap(), board: board ? g.tactical.scoreboard() : [] } : undefined
        ui.updateHud(g.hud(), g.standings(), board, pxPerRad, frameSeconds, extra)
      }
    },
  })
  cancelAnimationFrame(bootRaf)
  ui.setBootProgress(1, 'READY')
  loop.start()
  document.addEventListener('pointerlockchange', () => {
    // Browsers release pointer lock on Escape without delivering the key: treat that as pause.
    if (!document.pointerLockElement && (g.mode === 'playing' || g.mode === 'countdown') && input.method === 'keyboard' && !g.choosingPerk && !ui.tac.buyOpen) {
      lockLostAt = performance.now()
      pause()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  canvas.addEventListener('click', () => {
    if ((g.mode === 'playing' || g.mode === 'countdown') && !g.choosingPerk && !ui.tac.buyOpen) input.lockPointer()
  })
  // First gesture unlocks audio and (re)starts music blocked by the autoplay policy.
  const gesture = () => {
    audio.unlock()
    audio.retryMusic()
  }
  window.addEventListener('pointerdown', gesture)
  window.addEventListener('keydown', gesture)
  window.setTimeout(() => {
    ui.show(isRoomCode(invite) ? 'online' : 'title')
    document.getElementById('boot-ph')?.remove()
    audio.playMusic('title', 1.5)
    // Background streaming starts once the title is up.
    window.setTimeout(() => loader.startBackground(), 600)
  }, 250)
  // Debug/test hook (read-only use): smoke tests inspect match state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save, loader, audio }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">Failed to start: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
