# RiftStrike — Protocolo Spike

FPS tático 5v5 no navegador, inspirado no Valorant e feito para rodar em PC fraco e Chromebook.
Feito com Three.js (gráficos) e Rapier (física).

- **Modo Tático (Spike)**: atacantes contra defensores, de 2v2 a 5v5 contra bots. Tem fase de
  compra com créditos, spike para plantar no local A ou B e desarmar, troca de lado no meio da
  partida e vence quem fizer 5 rodadas primeiro.
- **Mata-mata** e **Sobrevivência** (8 ondas e um chefe) continuam disponíveis.
- **Mapa "Base Aurora"**: dois locais de spike (A e B), meio, corredores e barreiras de spawn
  na fase de compra.
- **7 mapas online inspirados em lugares reais**: Copacabana, Pelourinho, Veneza, Kyoto,
  Marrakech, Manhattan e a Base Aurora; o anfitrião escolhe no lobby.
- **Um mapa por modo**: Tático na Base Aurora (dia), Mata-mata no Mercado (pôr do sol, praça
  compacta) e Sobrevivência na Fortaleza (noite, pátio com janelas e postes acesos).
- **Online com amigos (2v2 a 5v5)**: no menu ONLINE, crie uma sala, mande o convite e jogue o
  modo tático com o servidor como autoridade. Veja [docs/ONLINE.md](docs/ONLINE.md).
- **Pronto para o Render**: um serviço só serve o jogo e as partidas (`render.yaml`). Veja
  [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

## Rodar

```bash
pnpm install
pnpm dev          # abre em http://localhost:3000
pnpm build        # gera a versão final em dist/ (site estático)
pnpm test         # testes de regras, economia, lobby e servidor
pnpm smoke        # depois do build: abre o jogo num navegador sem tela e joga os 3 modos
pnpm smoke:online # depois do build: dois navegadores jogam uma rodada online entre si
pnpm server       # servidor online (ws://localhost:8787); com o pnpm dev, o ONLINE já funciona
pnpm start        # depois do build: jogo + online em http://localhost:8787 (igual ao Render)
```

O `pnpm smoke` precisa do Chromium do Playwright. Se ele já estiver instalado em outro lugar,
use `CHROMIUM_PATH=/caminho/do/chromium pnpm smoke`.

## Controles

| Tecla | Ação |
| --- | --- |
| WASD + mouse | mover e mirar |
| Clique esquerdo / direito | atirar / mirar |
| R | recarregar |
| 1 / 2 | arma principal / pistola |
| B | loja (na fase de compra) |
| F ou 4 (segure) | plantar ou desarmar a spike |
| E / G | fumaça / granada |
| Shift | andar em silêncio |
| C ou Ctrl | agachar |
| Tab (segure) | placar |
| Esc | pausar |

## Desempenho (PC fraco e Chromebook)

- **Qualidade automática**: no primeiro acesso o jogo detecta a placa de vídeo, a memória e os
  núcleos do processador. Chromebooks e placas integradas fracas começam no modo **Baixo**.
- **Baixo**: desenha direto na tela, sem pós-processamento e sem sombras. O efeito vermelho de
  dano vira uma camada CSS, que não pesa na placa de vídeo.
- **Resolução dinâmica**: se o FPS cair abaixo de cerca de 45, a resolução interna baixa um
  pouco; quando sobra folga, ela volta a subir.
- **Mapa leve**: geometria procedural com materiais simples e texturas pequenas, juntada por
  material. O mapa inteiro custa umas dez chamadas de desenho.
- **Modelos mais leves**: personagens de 50 mil para 12,5 mil triângulos, texturas de
  1024 para 512 px, armas dos bots com 3 mil triângulos, e bots fora da tela nem são desenhados.
  O download total caiu de 25,4 MB para 14,5 MB.

## Onde fica cada coisa

| Caminho | O que é |
| --- | --- |
| `src/game/tactical.ts` | regras do modo tático (rodadas, economia, loja, spike), código puro e testado |
| `src/game/tacticalMatch.ts` | diretor da partida: times, bots com objetivos, plantar/desarmar, fumaça, espectador |
| `src/game/realMaps.ts` | os mapas online inspirados em lugares reais |
| `src/game/maps.ts` | definição dos mapas (layout, spawns, itens, céu e paleta) e qual modo usa qual |
| `src/game/arena.ts` | constrói um mapa (geometria, colisões, navegação dos bots, locais A/B) |
| `src/game/bots.ts` | IA dos bots (times, objetivos, combate) |
| `src/game/config.ts` | armas (perfil arcade e perfil tático) e ajustes gerais |
| `src/ui/tacticalHud.ts` | HUD tático: placar, minimapa, loja, placar do Tab |
| `src/engine/renderer.ts` | qualidade gráfica, resolução dinâmica, caminho sem pós-processamento |
| `src/net/*`, `server/match/*` | modo online: protocolo, salas, servidor (que também serve o jogo) |
| `src/ui/online.ts` | tela ONLINE: criar/entrar em sala, times, pronto, começar |
| `render.yaml` | configuração do deploy no Render |
| `tests/` | testes (regras táticas, rede, salvamento, ondas) |

## Créditos

Fontes: Bebas Neue (Dharma Type), Chakra Petch e Figtree, todas na licença SIL OFL
(veja `public/fonts/`). Bibliotecas: three.js (MIT), Rapier (Apache-2.0), ws (MIT).
