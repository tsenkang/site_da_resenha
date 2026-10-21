# site_da_resenha

## Skills do game-creator

As skills de jogos em `.claude/skills/` (make-game, quick-game, phaser, threejs-game, etc.)
vieram do plugin [opusgamelabs/game-creator](https://github.com/opusgamelabs/game-creator).
Quando elas citarem caminhos "relativos à raiz do plugin" ou "do repo root", use
`.claude/game-creator/`:

- `templates/phaser-2d/`, `templates/threejs-3d/` → `.claude/game-creator/templates/`
- `scripts/*.mjs` → `.claude/game-creator/scripts/`
- `assets/3d-characters/` → `.claude/game-creator/assets/3d-characters/`

A biblioteca `assets/characters/` (caricaturas para jogos de meme) não foi instalada.
