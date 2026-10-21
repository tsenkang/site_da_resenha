import { ONLINE_MAPS, type LobbyView, type OnlineMapId } from '../net/protocol'
import { MAPS } from '../game/maps'
import type { TeamIndex, TeamSize } from '../game/tactical'

/** What the online screen asks the app to do (main.ts owns the connection). */
export type OnlineActions = {
  create(name: string, teamSize: TeamSize): void
  join(name: string, code: string): void
  team(team: TeamIndex): void
  ready(on: boolean): void
  fillBots(on: boolean): void
  start(): void
  map(map: OnlineMapId): void
  leave(): void
}

type ButtonFactory = (label: string, onClick: () => void, cls?: string, sub?: string) => HTMLButtonElement

const NAME_KEY = 'riftstrike.name'
const safeGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const safeSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode: the name is just not remembered */
  }
}
const esc = (s: string) => s.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)

/**
 * Online screen: pick a name, create a room (2v2…5v5) or join one by code / invite link, then the
 * lobby (teams, ready, open slots, host start). The server is the source of truth for the lobby.
 */
export class OnlineView {
  readonly root: HTMLElement
  private readonly connectEl: HTMLElement
  private readonly lobbyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly nameIn: HTMLInputElement
  private readonly codeIn: HTMLInputElement
  private size: TeamSize = 2
  private lobby: LobbyView | null = null
  private me = ''
  private busy = false

  constructor(private readonly actions: OnlineActions, button: ButtonFactory, back: () => void) {
    const root = document.createElement('div')
    root.className = 'panel-screen'
    root.innerHTML = `
      <div class="panel panel-cut wide online">
        <h2>ONLINE</h2>
        <div class="ol-connect">
          <label class="ol-field"><span>SEU NOME</span><input class="ol-name" maxlength="16" autocomplete="nickname" spellcheck="false"></label>
          <div class="ol-block">
            <div class="ol-title">CRIAR SALA</div>
            <div class="ol-row"><div class="segs ol-sizes"></div><span class="ol-create"></span></div>
          </div>
          <div class="ol-block">
            <div class="ol-title">ENTRAR COM CÓDIGO</div>
            <div class="ol-row"><input class="ol-code-in" maxlength="5" placeholder="ABCDE" autocomplete="off" spellcheck="false"><span class="ol-join"></span></div>
          </div>
        </div>
        <div class="ol-lobby" hidden>
          <div class="ol-head">
            <div>SALA <b class="ol-code"></b> <small class="ol-size"></small></div>
            <span class="ol-copy"></span>
          </div>
          <div class="ol-teams">
            <div class="ol-team t0"><h3>TIME A <small>ataca primeiro</small></h3><ul></ul><span class="ol-pick"></span></div>
            <div class="ol-team t1"><h3>TIME B <small>defende primeiro</small></h3><ul></ul><span class="ol-pick"></span></div>
          </div>
          <div class="ol-title">MAPA <small class="ol-map-hint"></small></div>
          <div class="ol-maps"></div>
          <label class="ol-check"><input type="checkbox" class="ol-fill"> Começar com vagas abertas (os times podem ter tamanhos diferentes)</label>
          <div class="ol-row ol-actions"><span class="ol-ready"></span><span class="ol-start"></span></div>
        </div>
        <div class="ol-status"></div>
        <div class="menu row-end"><span class="ol-back"></span></div>
      </div>`
    this.root = root
    this.connectEl = root.querySelector('.ol-connect')!
    this.lobbyEl = root.querySelector('.ol-lobby')!
    this.statusEl = root.querySelector('.ol-status')!
    this.nameIn = root.querySelector('.ol-name')!
    this.codeIn = root.querySelector('.ol-code-in')!
    this.nameIn.value = safeGet(NAME_KEY) ?? ''
    this.codeIn.addEventListener('input', () => (this.codeIn.value = this.codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '')))
    // Typing in the form must not drive the game (WASD, Esc…).
    for (const i of [this.nameIn, this.codeIn]) i.addEventListener('keydown', e => e.stopPropagation())

    const sizes = root.querySelector('.ol-sizes')!
    for (const n of [2, 3, 4, 5] as TeamSize[]) {
      const b = document.createElement('button')
      b.className = `seg-btn ${n === this.size ? 'on' : ''}`
      b.textContent = `${n}v${n}`
      b.addEventListener('click', () => {
        this.size = n
        sizes.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b))
      })
      sizes.appendChild(b)
    }
    root.querySelector('.ol-create')!.replaceWith(button('CRIAR', () => this.withName(name => actions.create(name, this.size)), 'primary'))
    root.querySelector('.ol-join')!.replaceWith(
      button('ENTRAR', () =>
        this.withName(name => {
          if (this.codeIn.value.length !== 5) return this.status('O código da sala tem 5 letras.', 'warn')
          actions.join(name, this.codeIn.value)
        }),
      ),
    )
    root.querySelectorAll('.ol-pick').forEach((p, i) => p.replaceWith(button('ENTRAR NESTE TIME', () => actions.team(i as TeamIndex), 'ol-team-btn')))
    root.querySelector('.ol-ready')!.replaceWith(button('PRONTO', () => this.toggleReady(), 'ol-ready-btn'))
    root.querySelector('.ol-start')!.replaceWith(button('COMEÇAR PARTIDA', () => actions.start(), 'primary ol-start-btn'))
    root.querySelector('.ol-copy')!.replaceWith(button('COPIAR CONVITE', () => this.copyInvite(), 'ol-copy-btn'))
    const maps = root.querySelector('.ol-maps')!
    for (const id of ONLINE_MAPS) {
      const def = MAPS[id]
      const b = document.createElement('button')
      b.className = `ol-map map-${id}`
      b.dataset.map = id
      b.innerHTML = `<b>${def.name}</b><small>${def.place ?? ''}</small>`
      b.addEventListener('click', () => {
        if (this.lobby && this.lobby.players.find(p => p.id === this.me)?.host) actions.map(id)
      })
      maps.appendChild(b)
    }
    root.querySelector<HTMLInputElement>('.ol-fill')!.addEventListener('change', e => actions.fillBots((e.target as HTMLInputElement).checked))
    root.querySelector('.ol-back')!.replaceWith(
      button('VOLTAR', () => {
        if (this.lobby) actions.leave()
        this.reset()
        back()
      }),
    )
  }

  /** Room code from an invite link (`?sala=ABCDE`) goes straight into the join field. */
  prefill(code: string): void {
    this.codeIn.value = code
  }

  /** Back to the name/create/join form. */
  reset(): void {
    this.lobby = null
    this.busy = false
    this.connectEl.hidden = false
    this.lobbyEl.hidden = true
    this.status('')
  }

  setBusy(on: boolean, text = ''): void {
    this.busy = on
    this.root.classList.toggle('busy', on)
    if (text) this.status(text)
  }

  status(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    this.statusEl.textContent = text
    this.statusEl.dataset.kind = kind
  }

  showLobby(l: LobbyView, me: string): void {
    this.lobby = l
    this.me = me
    this.busy = false
    this.root.classList.remove('busy')
    this.connectEl.hidden = true
    this.lobbyEl.hidden = false
    const q = <T extends Element>(s: string) => this.root.querySelector<T>(s)!
    q('.ol-code').textContent = l.code
    const mine = l.players.find(p => p.id === me)
    const host = !!mine?.host
    for (const t of [0, 1] as TeamIndex[]) {
      const team = q(`.ol-team.t${t}`)
      const list = l.players.filter(p => p.team === t)
      const rows = list.map(p => `<li class="${p.id === me ? 'me' : ''}"><span>${esc(p.name)}${p.host ? ' <em>ANFITRIÃO</em>' : ''}</span><b class="${p.ready ? 'ok' : ''}">${p.ready ? 'PRONTO' : 'ESPERANDO'}</b></li>`)
      for (let i = list.length; i < l.teamSize; i += 1) rows.push(`<li class="open"><span>vaga aberta</span><b></b></li>`)
      team.querySelector('ul')!.innerHTML = rows.join('')
      team.querySelector<HTMLButtonElement>('.ol-team-btn')!.hidden = mine?.team === t || list.length >= l.teamSize
    }
    this.root.querySelectorAll<HTMLButtonElement>('.ol-map').forEach(b => {
      b.classList.toggle('on', b.dataset.map === l.map)
      b.disabled = !host
    })
    q('.ol-map-hint').textContent = host ? 'clique para escolher' : `escolhido pelo anfitrião: ${MAPS[l.map].name}`
    q('.ol-size').textContent = `${l.teamSize}v${l.teamSize} · ${MAPS[l.map].name}`
    const fill = q<HTMLInputElement>('.ol-fill')
    fill.checked = l.fillBots
    fill.disabled = !host
    const ready = q<HTMLButtonElement>('.ol-ready-btn')
    ready.hidden = host
    ready.querySelector('span')!.textContent = mine?.ready ? 'NÃO ESTOU PRONTO' : 'ESTOU PRONTO'
    const start = q<HTMLButtonElement>('.ol-start-btn')
    start.hidden = !host
    const waiting = l.players.filter(p => !p.ready).length
    const teamsOk = l.players.some(p => p.team === 0) && l.players.some(p => p.team === 1)
    start.disabled = waiting > 0 || !teamsOk
    if (!teamsOk) this.status(host ? 'Chame alguém: cada time precisa de pelo menos uma pessoa. Use COPIAR CONVITE.' : 'Esperando jogadores…')
    else if (waiting) this.status(host ? `Esperando ${waiting} jogador(es) ficar(em) pronto(s).` : 'Marque PRONTO quando estiver preparado.')
    else this.status(host ? 'Tudo pronto. Comece quando quiser!' : 'Esperando o anfitrião começar…', 'good')
  }

  private toggleReady(): void {
    const mine = this.lobby?.players.find(p => p.id === this.me)
    if (mine) this.actions.ready(!mine.ready)
  }

  private withName(fn: (name: string) => void): void {
    if (this.busy) return
    const name = this.nameIn.value.trim()
    if (name.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
      this.status('Escolha um nome com pelo menos 2 letras.', 'warn')
      this.nameIn.focus()
      return
    }
    safeSet(NAME_KEY, name)
    fn(name)
  }

  private copyInvite(): void {
    if (!this.lobby) return
    const url = `${location.origin}${location.pathname}?sala=${this.lobby.code}`
    const done = () => this.status(`Convite copiado: ${url}`, 'good')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this.status(`Envie este link: ${url}`))
    else this.status(`Envie este link: ${url}`)
  }
}
