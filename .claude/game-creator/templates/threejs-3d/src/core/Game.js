import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GAME, CAMERA, COLORS } from './Constants.js';
import { eventBus, Events } from './EventBus.js';
import { gameState } from './GameState.js';
import { InputSystem } from '../systems/InputSystem.js';
import { Player } from '../gameplay/Player.js';
import { LevelBuilder } from '../level/LevelBuilder.js';
import { Menu } from '../ui/Menu.js';

export class Game {
  constructor() {
    this.clock = new THREE.Clock();

    // Renderer (DPR capped for mobile GPU performance)
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, GAME.MAX_DPR));
    this.renderer.setClearColor(COLORS.SKY);
    this.renderer.shadowMap.enabled = true;
    document.body.prepend(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      GAME.FOV, window.innerWidth / window.innerHeight, GAME.NEAR, GAME.FAR
    );
    this.camera.position.set(0, CAMERA.HEIGHT, CAMERA.DISTANCE);

    // OrbitControls — third-person camera orbiting the player
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enablePan = false;
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.1;
    this.orbitControls.minDistance = CAMERA.MIN_DISTANCE;
    this.orbitControls.maxDistance = CAMERA.MAX_DISTANCE;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.orbitControls.target.set(0, 1, 0);
    this.orbitControls.update();

    // Systems
    this.input = new InputSystem();
    this.level = new LevelBuilder(this.scene);
    this.menu = new Menu();
    this.player = null;

    // Events
    eventBus.on(Events.GAME_RESTART, () => this.restart());

    // Resize
    window.addEventListener('resize', () => this.onResize());

    // Auto-start game (no title screen — Play.fun handles the chrome)
    this.startGame();

    // Start render loop (official Three.js pattern — pauses when tab hidden)
    this.renderer.setAnimationLoop(() => this.animate());
  }

  startGame() {
    gameState.reset();
    gameState.started = true;
    this.player = new Player(this.scene);
    this.input.setGameActive(true);
  }

  restart() {
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this.startGame();
  }

  animate() {
    const delta = Math.min(this.clock.getDelta(), GAME.MAX_DELTA);

    this.input.update();

    if (gameState.started && !gameState.gameOver && this.player) {
      // Camera-relative movement via OrbitControls azimuth
      const azimuth = this.orbitControls.getAzimuthalAngle();

      const oldX = this.player.mesh.position.x;
      const oldZ = this.player.mesh.position.z;

      this.player.update(delta, this.input, azimuth);

      // Camera follows player — move both target and camera by the same delta
      const dx = this.player.mesh.position.x - oldX;
      const dz = this.player.mesh.position.z - oldZ;
      this.orbitControls.target.x += dx;
      this.orbitControls.target.z += dz;
      this.orbitControls.target.y = this.player.mesh.position.y + 1;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }

    this.orbitControls.update();
    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
