import type { Audio } from '../engine/audio'
import { HALF_X, HALF_Z, type MapRect, type Site } from '../game/arena'

/** Size and world offset of the map shown on the minimap (rects are map-local, positions world). */
export type MinimapFrame = { hx: number; hz: number; ox: number; oz: number }
import { SHOP, type BuyResult, type Loadout, type ShopItem } from '../game/tactical'
import { GUNS, isGunId, type GunId } from '../game/gunSpecs'
import type { MinimapState, TacticalHud as HudData } from '../game/tacticalMatch'

/**
 * Tactical-mode HUD in the style of a tactical shooter: team strips + round score + timer on top,
 * minimap top-left, health/shield and abilities bottom-centre, plant/defuse channel bar, the buy
 * menu (B) and the Tab scoreboard. Plain DOM with change-checked writes; the minimap canvas is
 * redrawn at ~15 Hz so it costs next to nothing on weak machines.
 */
export type BoardRow = { name: string; team: 0 | 1; kills: number; deaths: number; credits: number; alive: boolean; isPlayer: boolean }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}
const clock = (s: number) => {
  const t = Math.max(0, Math.ceil(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
const credits = (n: number) => `<i class="cr"></i>${n.toLocaleString('pt-BR')}`

/** Buy menu columns, in the layout of a tactical shooter's buy menu. */
const SHOP_GROUPS: { title: string; items: ShopItem[] }[] = [
  { title: 'PISTOLAS', items: ['glock', 'dualies', 'p250', 'tec9', 'deagle'] },
  { title: 'NÍVEL MÉDIO', items: ['nova', 'xm1014', 'mp7', 'p90', 'mac10'] },
  { title: 'FUZIS', items: ['galil', 'ak47', 'ssg08', 'sg553', 'awp'] },
  { title: 'EQUIPAMENTO', items: ['lightShield', 'heavyShield', 'smoke', 'grenade'] },
]
const GUN_DESC: Record<GunId, string> = {
  glock: 'Inicial · rajada rápida, pouco dano',
  dualies: 'Duas pistolas · 30 balas',
  p250: 'Fura escudo · boa de cabeça',
  tec9: 'Automática de pistola · corre e atira',
  deagle: 'Headshot mata · recuo enorme',
  nova: 'Pump · 9 bagos, letal de perto',
  xm1014: 'Semiauto · 7 cartuchos',
  mp7: 'Precisa · recuo baixo',
  p90: '50 balas · red dot',
  mac10: 'Barata · cadência alta',
  galil: 'Fuzil barato · 35 balas',
  ak47: 'Headshot mata com escudo',
  ssg08: 'Leve · precisa no pulo',
  sg553: 'Luneta 2× · fura escudo',
  awp: 'Mata com 1 tiro no corpo',
}
const SHOP_DESC: Record<ShopItem, string> = {
  ...GUN_DESC,
  lightShield: '+25 de escudo',
  heavyShield: '+50 de escudo',
  smoke: 'E · bloqueia a visão por 15 s',
  grenade: 'G · explode após 1,6 s',
}
/** Small inline glyphs (no extra image files). */
export const GLYPH: Record<string, string> = {
  pistol: '<svg viewBox="0 0 48 24"><path d="M4 6h34l2 2v4H22l-2 2v7h-8l1-9H4z"/></svg>',
  shotgun: '<svg viewBox="0 0 64 24"><path d="M2 10h44l2-2h14v4H48l-4 3H26l-4 5h-8l3-6H2z"/></svg>',
  rifle: '<svg viewBox="0 0 64 24"><path d="M2 9h12V6h30l2 2h16v3H46v3h-8l-2 7h-6l1-7h-8l-3 4h-8l2-5H2z"/></svg>',
  lightShield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>',
  heavyShield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/></svg>',
  smoke: '<svg viewBox="0 0 24 24"><circle cx="8" cy="14" r="5"/><circle cx="15" cy="11" r="6"/><circle cx="17" cy="17" r="4"/></svg>',
  grenade: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="7"/><rect x="9" y="3" width="6" height="5" rx="1"/></svg>',
  spike: '<svg viewBox="0 0 24 24"><path d="M12 1l4 7-4 15-4-15z"/><rect x="5" y="9" width="14" height="3"/></svg>',
}

export class TacticalHudView {
  readonly root: HTMLElement
  private readonly E: Record<string, HTMLElement> = {}
  private readonly mapCanvas: HTMLCanvasElement
  private readonly mapCtx: CanvasRenderingContext2D
  private mapBase?: HTMLCanvasElement
  private rects: MapRect[] = []
  private sites: Site[] = []
  private mapT = 0
  private readonly buyEl: HTMLElement
  private readonly boardEl: HTMLElement
  private cards = new Map<ShopItem, HTMLElement>()
  private lastTop = ''
  private lastBuy = ''
  private lastBoard = ''
  private lastAb = ''
  buyOpen = false

  constructor(private readonly audio: Audio, private readonly onBuy: (item: ShopItem) => BuyResult | null, private readonly onClose: () => void) {
    this.root = el('div', 'tac', `
      <div class="th-top">
        <div class="th-team ally"></div>
        <div class="th-score">
          <div class="th-num ally" data-t="our">0</div>
          <div class="th-mid"><div class="th-clock" data-t="clock">0:00</div><div class="th-round" data-t="round">RODADA 1</div></div>
          <div class="th-num enemy" data-t="their">0</div>
        </div>
        <div class="th-team enemy"></div>
      </div>
      <div class="th-phase" data-t="phase"></div>
      <canvas class="th-map" width="220" height="220"></canvas>
      <div class="th-vitals">
        <div class="th-shield"><span class="th-shield-ico">${GLYPH.heavyShield}</span><b data-t="shield">0</b></div>
        <div class="th-hp"><b data-t="hp">100</b><div class="th-hpbar"><i data-t="hpbar"></i></div></div>
        <div class="th-abilities"></div>
      </div>
      <div class="th-progress"><div class="th-pl" data-t="plabel">PLANTANDO</div><div class="th-pbar"><i data-t="pbar"></i></div></div>
      <div class="th-hint" data-t="hint"></div>
      <div class="th-spectate" data-t="spectate"></div>`)
    this.root.querySelectorAll<HTMLElement>('[data-t]').forEach(e => (this.E[e.dataset.t!] = e))
    for (const c of ['th-team ally', 'th-team enemy', 'th-progress', 'th-abilities', 'th-score', 'th-top']) this.E[c] = this.root.querySelector(`.${c.replace(' ', '.')}`)!
    this.mapCanvas = this.root.querySelector('.th-map')!
    this.mapCtx = this.mapCanvas.getContext('2d')!
    this.buyEl = this.buildBuy()
    this.root.appendChild(this.buyEl)
    this.boardEl = el('div', 'th-board')
    this.root.appendChild(this.boardEl)
  }

  // ─── minimap ──────────────────────────────────────────────────────────
  private frame: MinimapFrame = { hx: HALF_X, hz: HALF_Z, ox: 0, oz: 0 }

  setMap(rects: MapRect[], sites: Site[], frame?: MinimapFrame): void {
    this.rects = rects
    this.sites = sites
    if (frame) this.frame = frame
    this.mapBase = undefined
  }

  /** Map-local metres → minimap pixels. */
  private toLocal(x: number, z: number): [number, number] {
    const S = this.mapCanvas.width
    const { hx, hz } = this.frame
    const half = Math.max(hx, hz)
    return [((x + half + 2) / (half * 2 + 4)) * S, ((z + half + 2) / (half * 2 + 4)) * S]
  }

  /** World position → minimap pixels. */
  private toMap(x: number, z: number): [number, number] {
    return this.toLocal(x - this.frame.ox, z - this.frame.oz)
  }

  private buildMapBase(): HTMLCanvasElement {
    const S = this.mapCanvas.width
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')!
    g.fillStyle = 'rgba(16, 24, 33, 0.82)'
    g.fillRect(0, 0, S, S)
    const [fx0, fz0] = this.toLocal(-this.frame.hx, -this.frame.hz)
    const [fx1, fz1] = this.toLocal(this.frame.hx, this.frame.hz)
    g.fillStyle = 'rgba(200, 214, 222, 0.30)'
    g.fillRect(fx0, fz0, fx1 - fx0, fz1 - fz0)
    for (const s of this.sites) {
      const [x0, z0] = this.toMap(s.center.x - s.halfX, s.center.z - s.halfZ)
      const [x1, z1] = this.toMap(s.center.x + s.halfX, s.center.z + s.halfZ)
      g.fillStyle = s.color + '55'
      g.fillRect(x0, z0, x1 - x0, z1 - z0)
      g.fillStyle = '#fff'
      g.font = 'bold 18px "Bebas Neue", sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(s.id, (x0 + x1) / 2, (z0 + z1) / 2)
    }
    for (const r of this.rects) {
      const [x0, z0] = this.toLocal(r.x0, r.z0)
      const [x1, z1] = this.toLocal(r.x1, r.z1)
      g.fillStyle = r.kind === 'water' ? 'rgba(60, 150, 200, 0.7)' : r.kind === 'cover' ? 'rgba(10, 16, 22, 0.75)' : 'rgba(10, 16, 22, 0.95)'
      g.fillRect(x0, z0, x1 - x0, z1 - z0)
    }
    return c
  }

  private drawMap(mm: MinimapState): void {
    const g = this.mapCtx
    const S = this.mapCanvas.width
    this.mapBase ??= this.buildMapBase()
    g.clearRect(0, 0, S, S)
    g.drawImage(this.mapBase, 0, 0)
    const dot = (x: number, z: number, r: number, fill: string, stroke = 'rgba(0,0,0,0.7)') => {
      const [px, pz] = this.toMap(x, z)
      g.beginPath()
      g.arc(px, pz, r, 0, Math.PI * 2)
      g.fillStyle = fill
      g.fill()
      g.lineWidth = 1.5
      g.strokeStyle = stroke
      g.stroke()
    }
    if (mm.spike) {
      const [px, pz] = this.toMap(mm.spike.x, mm.spike.z)
      g.fillStyle = mm.spike.planted ? '#ff4655' : '#ffb648'
      g.beginPath()
      g.moveTo(px, pz - 7)
      g.lineTo(px + 5, pz)
      g.lineTo(px, pz + 7)
      g.lineTo(px - 5, pz)
      g.closePath()
      g.fill()
    }
    for (const a of mm.allies) if (a.alive) dot(a.x, a.z, 4.5, '#3ce0c4')
    for (const e of mm.enemies) dot(e.x, e.z, 4.5, '#ff4655')
    if (mm.player.alive) {
      const [px, pz] = this.toMap(mm.player.x, mm.player.z)
      // View cone + arrow (yaw 0 faces −Z = up on the map).
      const a = -mm.player.yaw - Math.PI / 2
      g.fillStyle = 'rgba(255, 255, 255, 0.14)'
      g.beginPath()
      g.moveTo(px, pz)
      g.arc(px, pz, 30, a - 0.55, a + 0.55)
      g.closePath()
      g.fill()
      g.save()
      g.translate(px, pz)
      g.rotate(a + Math.PI / 2)
      g.fillStyle = '#f5f2ea'
      g.beginPath()
      g.moveTo(0, -7)
      g.lineTo(5, 5)
      g.lineTo(0, 2.5)
      g.lineTo(-5, 5)
      g.closePath()
      g.fill()
      g.restore()
    }
  }

  // ─── buy menu ─────────────────────────────────────────────────────────
  private buildBuy(): HTMLElement {
    const n = el('div', 'th-buy', `
      <div class="tb-panel">
        <div class="tb-head"><h2>LOJA</h2><div class="tb-credits" data-b="credits"></div><div class="tb-timer" data-b="timer"></div></div>
        <div class="tb-groups"></div>
        <div class="tb-team"><h3>SEU TIME</h3><div class="tb-team-rows"></div></div>
        <div class="tb-foot"><span><kbd>B</kbd> ou <kbd>Esc</kbd> fecha · clique para comprar · itens comprados ficam com você se sobreviver</span><button class="tb-close">PRONTO</button></div>
      </div>`)
    const groups = n.querySelector('.tb-groups')!
    for (const g of SHOP_GROUPS) {
      const col = el('div', 'tb-group', `<h3>${g.title}</h3>`)
      for (const item of g.items) {
        const def = SHOP[item]
        const gun = isGunId(item) ? GUNS[item] : null
        const glyph = gun ? GLYPH[gun.cls === 'pistol' ? 'pistol' : gun.cls === 'shotgun' ? 'shotgun' : 'rifle'] : GLYPH[item]
        const stats = gun
          ? `<div class="tb-stats"><span>DANO <b>${gun.damage}${gun.pellets > 1 ? `×${gun.pellets}` : ''}</b></span><span>PENTE <b>${gun.mag}</b></span><span>${gun.auto ? 'AUTO' : gun.bolt ? 'FERROLHO' : 'SEMI'}</span>${gun.sight !== 'iron' ? `<span>${gun.sight === 'dot' ? 'RED DOT' : 'LUNETA'}</span>` : ''}</div>`
          : ''
        const card = el('button', `tb-card ${gun ? 'gun' : ''}`, `<div class="tb-glyph" data-icon="${item}">${glyph}</div><div class="tb-name">${def.label}</div><div class="tb-price">${credits(def.price)}</div><div class="tb-desc">${SHOP_DESC[item]}</div>${stats}<div class="tb-own"></div>`)
        card.addEventListener('click', () => this.tryBuy(item, card))
        card.addEventListener('mouseenter', () => this.audio.play('ui_hover', { volume: 0.3 }))
        this.cards.set(item, card)
        col.appendChild(card)
      }
      groups.appendChild(col)
    }
    n.querySelector('.tb-close')!.addEventListener('click', () => this.onClose())
    n.addEventListener('mousedown', e => e.stopPropagation())
    return n
  }

  private iconsSet = false
  /** Swap the fallback glyphs for icons rendered from the gun models. */
  setGunIcons(icons: Partial<Record<GunId, string>>): void {
    if (this.iconsSet) return
    this.iconsSet = true
    this.buyEl.querySelectorAll<HTMLElement>('[data-icon]').forEach(e => {
      const src = icons[e.dataset.icon as GunId]
      if (src) e.innerHTML = `<img src="${src}" alt="">`
    })
  }

  private tryBuy(item: ShopItem, card: HTMLElement): void {
    const r = this.onBuy(item)
    if (!r) return
    card.classList.remove('ok', 'no')
    void card.offsetWidth
    card.classList.add(r.ok ? 'ok' : 'no')
    if (!r.ok) this.audio.play('ui_hover', { volume: 0.5, rate: 0.6 })
    this.lastBuy = ''
  }

  setBuyOpen(open: boolean): void {
    this.buyOpen = open
    this.buyEl.classList.toggle('on', open)
    this.lastBuy = ''
  }

  private updateBuy(h: HudData): void {
    const l = h.loadout
    const key = `${h.credits}|${l.primary}|${l.sidearm}|${l.shield}|${l.smokes}|${l.grenades}|${Math.ceil(h.timer)}|${h.allies.map(a => a.credits).join(',')}`
    if (key === this.lastBuy) return
    this.lastBuy = key
    const q = (k: string) => this.buyEl.querySelector<HTMLElement>(`[data-b="${k}"]`)!
    q('credits').innerHTML = credits(h.credits)
    q('timer').textContent = `COMPRA ${clock(h.timer)}`
    for (const [item, card] of this.cards) {
      const def = SHOP[item]
      const owned = owns(l, item)
      card.classList.toggle('owned', owned)
      card.classList.toggle('poor', !owned && h.credits < def.price)
      card.querySelector('.tb-own')!.textContent = owned ? (def.kind === 'ability' ? `${count(l, item)}/${def.max}` : 'EQUIPADO') : def.kind === 'ability' && count(l, item) > 0 ? `${count(l, item)}/${def.max}` : ''
    }
    this.buyEl.querySelector('.tb-team-rows')!.innerHTML = h.allies
      .map(a => `<div class="tb-mate ${a.isPlayer ? 'me' : ''}"><span>${a.name}</span><b>${credits(a.credits)}</b></div>`)
      .join('')
  }

  // ─── per-frame ────────────────────────────────────────────────────────
  update(h: HudData, mm: MinimapState | null, showBoard: boolean, board: BoardRow[], dt: number): void {
    const E = this.E
    const set = (k: string, v: string) => {
      const e = E[k]
      if (e && e.textContent !== v) e.textContent = v
    }
    // Top bar.
    set('our', String(h.score[0]))
    set('their', String(h.score[1]))
    const planted = h.phase === 'planted'
    set('clock', planted ? 'SPIKE' : clock(h.timer))
    set('round', planted ? clock(h.timer) : h.phase === 'buy' ? 'FASE DE COMPRA' : `RODADA ${h.round}`)
    E['th-score'].classList.toggle('planted', planted)
    E['th-score'].classList.toggle('urgent', !planted && h.phase === 'combat' && h.timer < 10)
    const top = `${h.allies.map(a => `${a.alive ? 1 : 0}${Math.round(a.hp / 10)}`).join('')}|${h.enemies.map(e => (e.alive ? 1 : 0)).join('')}|${h.side}`
    if (top !== this.lastTop) {
      this.lastTop = top
      E['th-team ally'].innerHTML = h.allies
        .map(a => `<div class="th-ava ${a.alive ? '' : 'dead'} ${a.isPlayer ? 'me' : ''}"><span>${a.name.slice(0, 2)}</span><i style="transform:scaleX(${a.alive ? Math.max(0, a.hp / 100) : 0})"></i></div>`)
        .join('')
      E['th-team enemy'].innerHTML = h.enemies.map(e => `<div class="th-ava ${e.alive ? '' : 'dead'}"><span>${e.name.slice(0, 2)}</span><i></i></div>`).join('')
      E['th-top'].dataset.side = h.side
    }
    // Phase line.
    let phase = ''
    if (h.phase === 'buy') phase = `${h.side === 'attack' ? 'ATAQUE' : 'DEFESA'} · APERTE B PARA COMPRAR · ${h.credits.toLocaleString('pt-BR')} CRÉDITOS`
    else if (h.spike.carried) phase = h.inSite ? `LOCAL ${h.inSite} · SEGURE F PARA PLANTAR` : 'VOCÊ ESTÁ COM A SPIKE · VÁ ATÉ O LOCAL A OU B'
    else if (h.spike.dropped && h.spike.teamHasIt) phase = 'A SPIKE CAIU · PEGUE-A'
    if (E.phase.textContent !== phase) E.phase.textContent = phase
    E.phase.classList.toggle('on', !!phase)
    // Vitals.
    const me = h.allies[0]
    set('hp', String(Math.max(0, me.hp)))
    set('shield', String(Math.max(0, me.shield)))
    E.hpbar.style.transform = `scaleX(${Math.max(0, me.hp) / 100})`
    E.hp.parentElement!.classList.toggle('low', me.hp <= 30)
    E.shield.parentElement!.classList.toggle('none', me.shield <= 0)
    const ab = `${h.loadout.grenades}|${h.loadout.smokes}|${h.spike.carried}`
    if (ab !== this.lastAb) {
      this.lastAb = ab
      E['th-abilities'].innerHTML = [
        `<div class="th-ab ${h.loadout.grenades ? '' : 'empty'}"><kbd>G</kbd>${GLYPH.grenade}<small>${h.loadout.grenades}</small></div>`,
        `<div class="th-ab ${h.loadout.smokes ? '' : 'empty'}"><kbd>E</kbd>${GLYPH.smoke}<small>${h.loadout.smokes}</small></div>`,
        h.spike.carried ? `<div class="th-ab spike"><kbd>F</kbd>${GLYPH.spike}<small>SPIKE</small></div>` : '',
      ].join('')
    }
    // Plant / defuse channel.
    E['th-progress'].classList.toggle('on', !!h.progress)
    if (h.progress) {
      set('plabel', h.progress.kind === 'plant' ? 'PLANTANDO A SPIKE' : 'DESARMANDO A SPIKE')
      E.pbar.style.transform = `scaleX(${Math.min(1, h.progress.t)})`
    }
    const hint = h.progress ? '' : h.hint ?? ''
    if (E.hint.textContent !== hint) E.hint.textContent = hint
    const dead = !me.alive && h.phase !== 'roundEnd' && h.phase !== 'matchEnd'
    set('spectate', dead ? 'VOCÊ FOI ELIMINADO · ASSISTINDO O TIME · CLIQUE PARA TROCAR' : '')
    E.spectate.classList.toggle('on', dead)
    // Buy menu follows the phase.
    if (this.buyOpen && !h.canBuy) this.onClose()
    if (this.buyOpen) this.updateBuy(h)
    // Minimap at ~15 Hz.
    this.mapT -= dt
    if (mm && this.mapT <= 0) {
      this.mapT = 1 / 15
      this.drawMap(mm)
    }
    // Scoreboard.
    this.boardEl.classList.toggle('on', showBoard)
    if (showBoard) {
      const rows = (team: 0 | 1) =>
        board
          .filter(r => r.team === team)
          .map(r => `<tr class="${r.isPlayer ? 'me' : ''} ${r.alive ? '' : 'dead'}"><td>${r.name}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${team === 0 ? credits(r.credits) : '—'}</td></tr>`)
          .join('')
      const html = `<div class="tbd-head"><span class="ally">SEU TIME ${h.score[0]}</span><span>RODADA ${h.round}</span><span class="enemy">${h.score[1]} INIMIGOS</span></div>
        <table><thead><tr><th>JOGADOR</th><th>K</th><th>D</th><th>CRÉDITOS</th></tr></thead><tbody class="ally">${rows(0)}</tbody><tbody class="enemy">${rows(1)}</tbody></table>`
      if (html !== this.lastBoard) {
        this.lastBoard = html
        this.boardEl.innerHTML = html
      }
    }
  }
}

function owns(l: Loadout, item: ShopItem): boolean {
  switch (item) {
    case 'lightShield':
      return l.shield >= 25
    case 'heavyShield':
      return l.shield >= 50
    case 'smoke':
      return l.smokes >= (SHOP.smoke.max ?? 1)
    case 'grenade':
      return l.grenades >= (SHOP.grenade.max ?? 1)
    default:
      return l.primary === item || l.sidearm === item
  }
}
function count(l: Loadout, item: ShopItem): number {
  return item === 'smoke' ? l.smokes : item === 'grenade' ? l.grenades : 0
}
