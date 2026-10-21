import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import type { Game, GameMode } from './game/game'
import { Ui } from './ui/ui'
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
  const startMatch = (mode?: GameMode) => {
    if (!game) return
    const selectedMode = mode ?? game.gameMode
    audio.unlock()
    audio.retryMusic()
    ui.resetHud()
    game.start(selectedMode)
    rankedRun = selectedMode === 'deathmatch'
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
  const pause = () => {
    if (game?.mode !== 'playing' && game?.mode !== 'countdown') return
    if (game.choosingPerk) return
    game.pause()
    ui.show('pause')
    input.unlockPointer()
  }
  const resume = () => {
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
  const ui = new Ui(i18n, save, audio, {
    play: mode => startMatch(mode),
    restart: () => startMatch(),
    resume,
    quit: () => {
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
  })
  ui.show('boot')
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
  const [{ Game }, { Renderer, suggestQuality }, physics, { Assets }, { loadLibrary }, { StageLoader }] = await Promise.all([
    import('./game/game'),
    import('./engine/renderer'),
    import('./engine/physics'),
    import('./engine/assets'),
    import('./game/library'),
    import('./game/stages'),
    document.fonts.ready,
  ])
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
    ended: (match, summary) => {
      input.unlockPointer()
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
      input.update()
      if (input.consume('pause') && performance.now() - lockLostAt > 300) {
        if (g.mode === 'playing' || g.mode === 'countdown') pause()
        else if (g.mode === 'paused' && ui.screen === 'pause') resume()
      }
      // Keyboard perk selection (1–3) while the perk cards are up.
      if (g.choosingPerk) {
        if (input.consume('slot1')) pickPerk(0)
        else if (input.consume('slot2')) pickPerk(1)
        else if (input.consume('slot3')) pickPerk(2)
      }
      g.render(alpha, frameSeconds)
      ui.tick(frameSeconds)
      if (g.mode === 'playing' || g.mode === 'countdown' || g.mode === 'ended' || g.mode === 'paused') {
        const pxPerRad = window.innerHeight / 2 / Math.tan((g.camera.fov * Math.PI) / 360)
        ui.updateHud(g.hud(), g.standings(), input.held('scoreboard'), pxPerRad, frameSeconds)
      }
    },
  })
  cancelAnimationFrame(bootRaf)
  ui.setBootProgress(1, 'READY')
  loop.start()
  document.addEventListener('pointerlockchange', () => {
    // Browsers release pointer lock on Escape without delivering the key: treat that as pause.
    if (!document.pointerLockElement && (g.mode === 'playing' || g.mode === 'countdown') && input.method === 'keyboard' && !g.choosingPerk) {
      lockLostAt = performance.now()
      pause()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  canvas.addEventListener('click', () => {
    if ((g.mode === 'playing' || g.mode === 'countdown') && !g.choosingPerk) input.lockPointer()
  })
  // First gesture unlocks audio and (re)starts music blocked by the autoplay policy.
  const gesture = () => {
    audio.unlock()
    audio.retryMusic()
  }
  window.addEventListener('pointerdown', gesture)
  window.addEventListener('keydown', gesture)
  window.setTimeout(() => {
    ui.show('title')
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
