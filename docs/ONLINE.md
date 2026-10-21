# Modo online (2v2 a 5v5): o que já existe e o que falta

O jogo ainda é jogado contra bots, mas a base do online já está pronta e testada.
Este documento explica como ela funciona e qual é o próximo passo.

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

## Próximos passos (em ordem)

1. **Tela de lobby no jogo**: ligar o botão "ONLINE" a uma tela que cria sala, mostra o código,
   lista os times e tem os botões "pronto" e "começar" (o `NetClient` já faz a conexão).
2. **Jogadores remotos no mapa**: para cada jogador da sala, criar um personagem igual aos bots
   (`createTacticalBot`) e mover pela interpolação dos `snapshot` (cerca de 100 ms de atraso).
3. **Enviar o jogo local para a rede**: `streamFrames` com a posição e a mira do jogador, `hit`
   quando o tiro acerta alguém remoto, `buy`, `plant` e `defuse` no lugar das chamadas locais
   (o `TacticalMatch` passa a só mostrar o `round` que vem do servidor).
4. **Bots online**: o computador do anfitrião roda a IA dos bots e envia os quadros deles.
5. **Antitrapaça mais forte**: o servidor conferir a linha de tiro com o mapa (o mapa é
   procedural e roda no Node) e compensar a latência voltando as posições no tempo.

Os passos 1 a 3 já dão partidas online jogáveis entre amigos.
