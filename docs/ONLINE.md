# Modo online (2v2 a 5v5)

O modo tático já pode ser jogado online com amigos. Pelo menu **ONLINE** você cria uma sala,
copia o convite e começa quando todos estiverem prontos. Para colocar no ar, veja
[DEPLOY_RENDER.md](DEPLOY_RENDER.md).

## Como rodar o servidor

```bash
pnpm install
pnpm server            # sobe em ws://localhost:8787 (Node 22.18 ou mais novo)
curl localhost:8787/health
```

Variáveis de ambiente:

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `PORT` | porta HTTP/WebSocket | `8787` |
| `ORIGINS` | sites que podem conectar, separados por vírgula (ex.: `https://meujogo.com`) | qualquer um |

Funciona em qualquer hospedagem que rode Node e aceite WebSocket (Render, Fly.io, Railway,
uma VPS). O site do jogo (pasta `dist/`) continua sendo estático e pode ficar em outro lugar.

## Arquitetura

```
navegador (jogo)                         servidor (server/match)
─────────────────                        ───────────────────────
src/net/client.ts  ── WebSocket JSON ──▶  server.ts  (conexões, salas, limite de mensagens)
src/net/protocol.ts   (mesmos tipos)       room.ts    (lobby → partida, validações)
                                           src/game/tactical.ts  (as MESMAS regras do jogo local)
```

- **`src/net/protocol.ts`**: todas as mensagens (`hello`, `create`, `join`, `team`, `ready`,
  `start`, `frame`, `hit`, `buy`, `plant`, `defuse`…) e a validação de tudo que chega do
  cliente. O servidor nunca lê JSON cru fora dessa função.
- **`src/net/lobby.ts`**: regras da sala. Código de 5 letras, times balanceados automaticamente,
  troca de time, "pronto", o anfitrião passa para outra pessoa quando sai, e vagas abertas.
- **`server/match/room.ts`**: a sala em si. O servidor é a autoridade sobre:
  - fases da rodada, tempo, placar, troca de lado e fim da partida;
  - economia e compras (créditos, armas, escudos, habilidades);
  - plantar e desarmar a spike;
  - dano e mortes: o cliente avisa "acertei X" e o servidor confere se a arma é dele, a cadência
    de tiro, o dano máximo da arma, o alcance, a distância real entre os dois, se ambos estão vivos
    e se são de times diferentes.
- **Movimento**: cada cliente simula o próprio movimento e manda a posição 20 vezes por segundo.
  O servidor repassa para os outros e descarta velocidades impossíveis.
- **Vagas abertas**: com `fillBots` ligado, a sala começa mesmo sem todos os jogadores (por
  exemplo, 2 contra 1). As vagas vazias contam como eliminadas no início de cada rodada.

Tudo isso tem testes em `tests/net.test.ts`, incluindo um teste com dois clientes reais
conectando por WebSocket, criando sala, entrando e começando a partida.

## Mapas online

O anfitrião escolhe o mapa no lobby; a sala começa com um mapa sorteado. Todos seguem a mesma
estrutura da Base Aurora (ataque ao norte, defesa ao sul, locais A e B, barreiras na fase de
compra), mas cada um tem ruas, locais, coberturas, cores, céu, piso e um marco do lugar:

| Mapa | Inspirado em | Destaques |
| --- | --- | --- |
| Base Aurora | vila mediterrânea | o mapa original |
| Copacabana | Rio de Janeiro | calçadão de ondas, praia com guarda-sóis, Pão de Açúcar e Cristo no horizonte, mar |
| Pelourinho | Salvador | casarões coloridos, paralelepípedo, igreja de torres gêmeas entre os locais |
| Veneza | Veneza | canal atravessando o mapa com três pontes, gôndolas, campanário |
| Kyoto | Kyoto | portais torii, lanternas de pedra, cerejeiras, cascalho, pagode |
| Marrakech | Marrakech | becos do souk com barracas, palmeiras, telhados planos, minarete ao entardecer |
| Manhattan | Nova York | noite, arranha-céus com janelas acesas, avenida com táxis, skyline |

Os mapas são definidos em `src/game/realMaps.ts` (layout em unidades de projeto) e a lista do
online fica em `ONLINE_MAPS` (`src/net/protocol.ts`). As posições vão pela rede relativas ao
mapa, então o servidor não precisa saber onde cada mapa foi montado.

## Como o jogo usa a rede

- **Lobby** (`src/ui/online.ts`): nome, criar sala (2v2 a 5v5), entrar com código ou pelo link
  `?sala=CÓDIGO`, trocar de time, "pronto", vagas abertas e "começar" (só o anfitrião).
- **Partida** (`src/net/link.ts` e `src/net/view.ts`): o modo tático local roda em "modo rede".
  O servidor manda o estado completo das regras e o jogo só mostra o resultado:
  - você vira o id 0 no time 0, e se você estiver no segundo time do servidor, times e placar
    são espelhados;
  - as mudanças de estado viram os mesmos eventos de sempre (combate, spike plantada, fim de
    rodada, troca de lado, fim de partida).
- **Outros jogadores** são bonecos sem IA (`Bot.remote`). Eles se movem pela interpolação dos
  snapshots, com cerca de 100 ms de atraso, e mostram os tiros com clarão, traçante e som.
- **Seus tiros** em outro jogador viram um pedido de acerto (`hit`), juntando os chumbos da
  escopeta num pedido só. O servidor confere e responde com `damage` e `kill`, e só então vida e
  mortes mudam.
- **Spike**: quem leva a spike é sorteado entre as pessoas do ataque. Ela cai onde o portador
  morreu, e qualquer atacante que passar por cima pega. Plantar só vale para o portador (na
  posição dele); desarmar só vale perto da spike.
- **Fumaça e granada**: quem lança avisa onde caiu. O servidor confere se a pessoa tem o item,
  repassa para todos e calcula o dano da granada sozinho.
- **Servidor**: o mesmo processo serve o jogo e o WebSocket. O cliente conecta em `/ws` no mesmo
  endereço, ou em `VITE_SERVER_URL` se ela for definida no build.

## Próximos passos

1. **Bots online**: hoje as vagas abertas ficam fora da rodada. O computador do anfitrião
   poderia rodar a IA dos bots e enviar os quadros deles.
2. **Antitrapaça mais forte**: o servidor conferir a linha de tiro com o mapa (o mapa é
   procedural e roda no Node) e compensar a latência voltando as posições no tempo. Também
   conferir se a planta foi dentro do local A ou B.
3. **Reconectar**: voltar para a mesma sala se a conexão cair no meio da partida.
