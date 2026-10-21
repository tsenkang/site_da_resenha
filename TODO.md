# RiftStrike — TODO

## Remixar o jogo base fornecido
- [x] Integrar o source, assets e configuração do pacote completo do showcase FPS Iron Rift, preservando a compatibilidade com o runtime Three.js/Vite inicializado.
- [x] Manter a identidade original do remix como RiftStrike, sem substituir o starter por outro engine ou runtime.

## FPS competitivo em partidas rápidas
- [x] Implementar movimentação ágil em primeira pessoa, com mira e disparos responsivos para combates rápidos.
- [x] Construir um mapa compacto com linhas de visão claras, leitura imediata do espaço e confrontos competitivos.
- [x] Implementar ciclo de partida com placar de eliminações, respawn e feedback visual de acerto.
- [x] Exibir HUD em português brasileiro com objetivo, tempo, eliminações, munição e estado da partida.
- [x] Manter leaderboard online em modo guest quando disponível e preservar o jogo local quando a API estiver indisponível; o Preview local usa fallback offline sem requests quebrados.

## Direção cartonizada e performance
- [x] Usar visual 3D cartonizado/low-poly com cores chapadas, silhuetas legíveis e efeitos simples.
- [x] Evitar pós-processamento pesado, geometria complexa, materiais custosos e excesso de partículas.
- [x] Manter iluminação econômica, renderização eficiente, controles responsivos e carregamento leve.
- [x] Preservar e adaptar o sistema de Tweak existente somente para parâmetros com consumidores reais.
- [x] Remover assets de runtime sem referência (HDRI, texturas de cenário e splash herdado) e reduzir o transfer estimado do build de 31,82 MB para 25,44 MB.

## Qualidade de entrega
- [x] Manter todas as strings visíveis em pt-BR e os catálogos de localização consistentes.
- [x] Corrigir o shader GLSL herdado do showcase que gerava erros WebGL em software GL, mantendo materiais planos leves.
- [x] Preparar compartilhamento com metadata própria, favicon PNG e capa OG específica do RiftStrike.
- [x] Rodar TypeScript, testes (31/31), build de produção e smoke test end-to-end.
- [ ] Salvar checkpoint Git no SHA final e publicar somente após autorização explícita do usuário.
