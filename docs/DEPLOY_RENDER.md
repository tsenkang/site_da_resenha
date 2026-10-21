# Publicar no Render (jogo + modo online)

Um único serviço do Render roda tudo: o servidor Node serve o jogo (pasta `dist/`) e as
partidas online (WebSocket em `/ws`) no mesmo endereço. Não precisa configurar URL de
servidor no jogo.

## Passo a passo

1. Envie este repositório para o GitHub (já está em `tsenkang/site_da_resenha`).
2. No [Render](https://render.com), clique em **New → Blueprint**.
3. Escolha o repositório. O Render lê o `render.yaml` e cria o serviço **riftstrike**.
4. Clique em **Apply** e espere o primeiro deploy (uns 3 a 5 minutos).
5. Abra o endereço que o Render mostrar (algo como `https://riftstrike.onrender.com`).

Pronto. No menu do jogo, clique em **ONLINE**, escolha um nome e **CRIAR**. Depois clique em
**COPIAR CONVITE** e mande o link para os amigos. O link abre o jogo já com o código da sala.

### Sem Blueprint (configurando à mão)

Em **New → Web Service**, escolha o repositório e preencha:

| Campo | Valor |
| --- | --- |
| Runtime | Node |
| Build Command | `corepack enable && pnpm install --frozen-lockfile && pnpm run build:web` |
| Start Command | `pnpm start` |
| Health Check Path | `/health` |

E as variáveis de ambiente:

| Variável | Valor | Para quê |
| --- | --- | --- |
| `NODE_VERSION` | `22` | o servidor roda TypeScript direto (Node 22.18 ou mais novo) |
| `SKIP_INSTALL_DEPS` | `true` | quem instala é o pnpm do Build Command |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` | não baixar navegadores de teste no servidor |

## Variáveis opcionais

| Variável | Para quê |
| --- | --- |
| `ORIGINS` | só aceitar conexões vindas destes sites, separados por vírgula (ex.: `https://riftstrike.onrender.com`) |
| `STATIC_DIR` | outra pasta com o jogo compilado (padrão: `dist`) |

O Render define `PORT` sozinho.

## Coisas para saber

- **Plano grátis dorme.** Depois de uns 15 minutos sem ninguém acessando, o serviço desliga.
  O próximo acesso demora cerca de 1 minuto para acordar. Partidas em andamento mantêm o
  serviço acordado. Para não dormir nunca, use um plano pago.
- **Uma instância só.** As salas ficam na memória do servidor. Não aumente o número de
  instâncias, senão jogadores da mesma sala podem cair em servidores diferentes. Um deploy
  novo encerra as partidas em andamento.
- **Conferir se está no ar:** `https://SEU-ENDERECO/health` responde
  `{"ok":true,"rooms":0,"protocol":1}`.

## Rodar igual ao Render no seu PC

```bash
pnpm install
pnpm run build:web
pnpm start                # http://localhost:8787 (jogo + online)
```

Para desenvolver com recarga automática, rode `pnpm server` num terminal e `pnpm dev` em
outro. O Vite repassa o `/ws` para o servidor na porta 8787.

## Jogo e servidor em lugares diferentes

Se o site ficar em outro lugar (GitHub Pages, itch.io…) e só o servidor no Render, compile o
jogo apontando para o servidor:

```bash
VITE_SERVER_URL=wss://riftstrike.onrender.com/ws pnpm run build:web
```

Coloque o endereço do site em `ORIGINS` no Render.
