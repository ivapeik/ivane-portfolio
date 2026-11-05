/* ==========================================================================
   Turntable hero (home page only)
   --------------------------------------------------------------------------
   A small WebGL2 scene written without libraries.

   How it works:
   - The portrait is a "billboard": a flat card that always faces the camera.
   - assets/turntable.webp holds 40 photos of the figure, one every 9 degrees,
     in a grid of 10 columns x 4 rows. Every 5th one is a real photo; the ones
     in between are single warped copies of the nearest real photo.
   - The opening shot starts with the figure in side view (INTRO_FROM) and
     turns him to face the visitor as the light comes on.
   - After that the figure faces the visitor (0 degrees) and stays still until
     the mouse points at it, a finger drags it or a layer is picked; then it
     turns back.
   - The camera really orbits the stage. The figure always comes to rest on a
     real photo and only passes through the in-between frames while turning,
     so every pose you can stop on is a real one.
   - Floor, light beam and dust are drawn around the figure with tiny shaders.

   Layout lives in CSS: the variables --fig-x, --fig-top and --fig-bottom on
   .hero decide where the figure sits on screen. This file reads them.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     1. Settings
     ------------------------------------------------------------------------ */

  const ATLAS = {
    frames: 40,        // photos in the atlas
    columns: 10,
    rows: 4,
    cellWidth: 260,    // pixels per photo
    cellHeight: 844,
    feetPx: 17,        // empty pixels below the shoes
    headPx: 13         // empty pixels above the head
  };
  const DEGREES_PER_FRAME = 360 / ATLAS.frames;   // 9
  const POSE_STEP = 45;                            // a real photo every 45 degrees

  const FIGURE_HEIGHT = 1.8;   // metres, head to sole

  const CAMERA = {
    distance: 5.2,     // metres from the figure
    height: 1.45,      // eye height
    lookAt: 0.78,      // height the camera aims at
    fov: 32            // vertical field of view, degrees
  };

  // Horizontal directions the lights come from (x, z), fixed in the world.
  const KEY_LIGHT = [-0.85, 0.53];   // warm tungsten key, front left
  const RIM_LIGHT = [0.75, -0.66];   // cool back light, rear right

  // The figure stands still at 0 degrees. It turns only while the visitor
  // points at it, drags it or picks a layer, then turns back to face them.
  const RETURN_DELAY = {
    afterHover: 150,   // ms after the mouse leaves the figure
    afterDrag: 1500,   // ms after a finger lets go
    afterPick: 4000    // ms after a layer button or arrow key
  };
  const HOVER_ZONE = 0.2;   // half-width of the area around the figure, as a share of the hero width

  // Angle the opening shot starts from: 90 = side view, facing right.
  // The figure turns from here to 0 (facing the visitor) during the intro.
  const INTRO_FROM = 90;

  /* ------------------------------------------------------------------------
     2. Page elements
     ------------------------------------------------------------------------ */

  const hero = document.querySelector('.hero');
  if (!hero) return;

  const canvas = hero.querySelector('.hero__stage');
  const dial = hero.querySelector('.hero__dial');
  const dialValue = hero.querySelector('.dial__value');
  const layerItems = Array.from(hero.querySelectorAll('.layers__item'));
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function reveal() {
    root.classList.add('is-revealed');
  }

  function showStillImage() {
    hero.classList.add('is-static');
    reveal();
  }

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true });
  if (!gl) {
    showStillImage();
    return;
  }

  /* ------------------------------------------------------------------------
     3. Small maths helpers
     ------------------------------------------------------------------------ */

  const DEG = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Moves `current` toward `target`; the same feel at any frame rate.
  function follow(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-speed * dt));
  }

  // 0..359
  function wrapAngle(angle) {
    return ((angle % 360) + 360) % 360;
  }

  // The copy of `angle` (plus or minus whole turns) closest to `from`.
  function nearestTurn(angle, from) {
    return angle + 360 * Math.round((from - angle) / 360);
  }

  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  // View matrix for a camera at `eye` looking at `target`, with +Y as up.
  function lookAt(eye, target) {
    let zx = eye[0] - target[0];
    let zy = eye[1] - target[1];
    let zz = eye[2] - target[2];
    let length = Math.hypot(zx, zy, zz);
    zx /= length; zy /= length; zz /= length;

    let xx = zz;
    let xz = -zx;
    length = Math.hypot(xx, xz);
    xx /= length; xz /= length;

    const yx = zy * xz;
    const yy = zz * xx - zx * xz;
    const yz = -zy * xx;

    return new Float32Array([
      xx, yx, zx, 0,
      0, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1
    ]);
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[row] * b[col * 4] +
          a[4 + row] * b[col * 4 + 1] +
          a[8 + row] * b[col * 4 + 2] +
          a[12 + row] * b[col * 4 + 3];
      }
    }
    return out;
  }

  // World point -> normalised screen coordinates (-1..1).
  function project(matrix, point) {
    const x = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12];
    const y = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13];
    const w = matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15];
    return [x / w, y / w];
  }

  /* ------------------------------------------------------------------------
     4. Shaders
     ------------------------------------------------------------------------ */

  // Every 3D shader applies the same "lens": a zoom and shift that puts the
  // figure exactly where the CSS variables ask for it.
  const LENS = `
    uniform vec3 uLens;
    vec4 applyLens(vec4 clip) {
      clip.xy = clip.xy * uLens.x + uLens.yz * clip.w;
      return clip;
    }
  `;

  const FULLSCREEN_VERTEX = `#version 300 es
    void main() {
      vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
    }
  `;

  // The dark void, a soft halo behind the figure and a vignette.
  const BACKGROUND_FRAGMENT = `#version 300 es
    precision highp float;
    uniform vec2 uResolution;
    uniform vec2 uFigure;
    uniform float uLight;
    out vec4 outColor;

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution;
      vec2 ndc = uv * 2.0 - 1.0;
      float aspect = uResolution.x / uResolution.y;
      vec3 color = vec3(0.039, 0.055, 0.098);

      vec2 d = (ndc - uFigure) * vec2(aspect, 1.0);
      float halo = exp(-(d.x * d.x) / 0.42 - (d.y * d.y) / 1.9);
      color += vec3(0.055, 0.07, 0.115) * halo;
      color += vec3(0.13, 0.085, 0.045) * halo * 0.45 * uLight;

      float lamp = exp(-(d.x * d.x) / 0.05) * smoothstep(-0.1, 1.1, ndc.y);
      color += vec3(0.16, 0.115, 0.07) * lamp * 0.35 * uLight;

      float vignette = smoothstep(1.7, 0.35, length(ndc * vec2(1.0, 0.85)));
      color *= mix(0.42, 1.0, vignette);
      outColor = vec4(color, 1.0);
    }
  `;

  const FLOOR_VERTEX = `#version 300 es
    layout(location = 0) in vec2 aCorner;
    uniform mat4 uViewProjection;
    ${LENS}
    out vec3 vWorld;

    void main() {
      vec3 position = vec3(aCorner.x, 0.0, aCorner.y * 2.0 - 1.0) * vec3(9.0, 1.0, 9.0);
      vWorld = position;
      gl_Position = applyLens(uViewProjection * vec4(position, 1.0));
    }
  `;

  // Light pool, turntable rings with degree ticks, and shadows.
  const FLOOR_FRAGMENT = `#version 300 es
    precision highp float;
    in vec3 vWorld;
    uniform float uLight;
    uniform vec2 uShadowDirection;
    out vec4 outColor;

    const vec3 TUNGSTEN = vec3(0.91, 0.725, 0.494);

    float ring(float r, float radius, float width, float aa) {
      return 1.0 - smoothstep(width * 0.5, width * 0.5 + aa, abs(r - radius));
    }

    void main() {
      vec2 p = vWorld.xz;
      float r = length(p);
      float aa = fwidth(r) * 1.25;
      vec3 color = vec3(0.039, 0.055, 0.098);

      // pool of light under the spot
      color += vec3(0.95, 0.66, 0.36) * exp(-r * r / 1.7) * 0.13 * uLight;
      color += vec3(0.2, 0.28, 0.45) * exp(-r * r / 8.0) * 0.045;

      // turntable markings
      float angle = degrees(atan(p.y, p.x));
      float shortBand = smoothstep(0.950, 0.956, r) * (1.0 - smoothstep(0.995, 1.001, r));
      float longBand = smoothstep(0.950, 0.956, r) * (1.0 - smoothstep(1.055, 1.061, r));
      float distTo5 = abs(fract(angle / 5.0 + 0.5) - 0.5) * radians(5.0) * r;
      float distTo45 = abs(fract(angle / 45.0 + 0.5) - 0.5) * radians(45.0) * r;
      float minorTicks = (1.0 - smoothstep(0.0028, 0.0028 + aa, distTo5)) * shortBand;
      float majorTicks = (1.0 - smoothstep(0.0045, 0.0045 + aa, distTo45)) * longBand;

      float lines = ring(r, 0.95, 0.006, aa) * 0.42
                  + ring(r, 0.885, 0.003, aa) * 0.14
                  + minorTicks * 0.2
                  + majorTicks * 0.5
                  + ring(r, 1.9, 0.004, aa) * 0.06
                  + ring(r, 3.1, 0.004, aa) * 0.035;
      color += TUNGSTEN * lines * mix(0.3, 1.0, uLight);

      // contact shadow and a long shadow away from the key light
      float contact = exp(-r * r / 0.03);
      float along = dot(p, uShadowDirection);
      float across = dot(p, vec2(-uShadowDirection.y, uShadowDirection.x));
      float longShadow = exp(-across * across / (0.01 + 0.025 * max(along, 0.0)))
                       * smoothstep(-0.06, 0.12, along)
                       * exp(-max(along, 0.0) * 0.9);
      color *= 1.0 - 0.8 * contact - 0.55 * longShadow * uLight;

      float alpha = 1.0 - smoothstep(2.4, 7.0, r);
      outColor = vec4(color, alpha);
    }
  `;

  const FIGURE_VERTEX = `#version 300 es
    layout(location = 0) in vec2 aCorner;
    uniform mat4 uViewProjection;
    ${LENS}
    uniform vec3 uCamera;
    uniform vec2 uSize;
    uniform float uOffsetY;
    uniform float uReflection;
    out vec2 vUv;
    out float vHeight;

    void main() {
      // turn the card around the vertical axis so it faces the camera
      vec3 toCamera = normalize(vec3(uCamera.x, 0.0, uCamera.z));
      vec3 right = vec3(toCamera.z, 0.0, -toCamera.x);

      float x = aCorner.x * 0.5;
      float y = aCorner.y * uSize.y + uOffsetY;
      if (uReflection > 0.5) y = -y;   // mirrored under the floor

      vec3 position = right * (x * uSize.x) + vec3(0.0, y, 0.0);
      vUv = vec2(x + 0.5, 1.0 - aCorner.y);
      vHeight = y;
      gl_Position = applyLens(uViewProjection * vec4(position, 1.0));
    }
  `;

  const FIGURE_FRAGMENT = `#version 300 es
    precision highp float;
    uniform sampler2D uAtlas;
    uniform vec2 uGrid;            // columns, rows
    uniform float uFrameCount;
    uniform vec2 uPixel;           // one source pixel, in cell units
    uniform float uFrame;          // continuous frame number
    uniform float uLight;
    uniform float uReflection;
    uniform float uOpacity;
    uniform vec2 uKey;             // x: which side of the screen, y: strength
    uniform vec2 uRim;
    in vec2 vUv;
    in float vHeight;
    out vec4 outColor;

    vec4 sampleFrame(float index, vec2 uv, float bias) {
      uv = clamp(uv, vec2(0.004, 0.002), vec2(0.996, 0.998));
      vec2 cell = vec2(mod(index, uGrid.x), floor(index / uGrid.x));
      return texture(uAtlas, (cell + uv) / uGrid, bias);
    }

    // Close to 1 on the edge of the silhouette that faces 'direction'.
    float edge(float index, vec2 uv, vec2 direction) {
      vec2 step = direction * uPixel;
      float covered = sampleFrame(index, uv + step * 1.5, 0.0).a
                    + sampleFrame(index, uv + step * 3.0, 0.0).a
                    + sampleFrame(index, uv + step * 5.5, 0.0).a;
      return 1.0 - covered / 3.0;
    }

    vec4 shade(float index, vec2 uv, float bias) {
      vec4 texel = sampleFrame(index, uv, bias);
      if (texel.a < 0.002) return vec4(0.0);
      vec3 color = texel.rgb / texel.a;

      // film grade: cooler shadows, warmer highlights, light falling from above
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = pow(color, vec3(1.12));
      color *= mix(vec3(0.76, 0.83, 1.0), vec3(1.07, 1.0, 0.9), smoothstep(0.08, 0.75, luminance));
      color *= mix(1.1, 0.52, smoothstep(0.06, 1.0, uv.y));
      color *= mix(0.14, 1.0, uLight);

      if (uReflection < 0.5) {
        float keyEdge = edge(index, uv, normalize(vec2(uKey.x, -0.6)));
        float rimEdge = edge(index, uv, normalize(vec2(uRim.x, -0.4)));
        color += vec3(1.0, 0.76, 0.5) * keyEdge * uKey.y * uLight * 1.3;
        color += vec3(0.56, 0.7, 1.0) * rimEdge * uRim.y * 1.25;
      }
      return vec4(color * texel.a, texel.a);
    }

    void main() {
      float frame = mod(uFrame, uFrameCount);
      float current = floor(frame);
      float next = mod(current + 1.0, uFrameCount);
      float blend = smoothstep(0.25, 0.75, frame - current);
      float bias = uReflection > 0.5 ? 2.2 : 0.0;

      vec4 color = shade(current, vUv, bias) * (1.0 - blend);
      if (blend > 0.001) color += shade(next, vUv, bias) * blend;

      if (uReflection > 0.5) color *= exp(vHeight * 2.4) * 0.26;
      color *= uOpacity;
      if (color.a < 0.004) discard;
      outColor = color;
    }
  `;

  const BEAM_VERTEX = `#version 300 es
    layout(location = 0) in vec2 aCorner;
    uniform mat4 uViewProjection;
    ${LENS}
    uniform vec3 uCamera;
    out vec2 vBeam;   // x: metres across the beam, y: metres up

    void main() {
      vec3 toCamera = normalize(vec3(uCamera.x, 0.0, uCamera.z));
      vec3 right = vec3(toCamera.z, 0.0, -toCamera.x);
      float halfWidth = mix(0.95, 0.07, aCorner.y);
      vec3 position = right * aCorner.x * halfWidth + vec3(0.0, aCorner.y * 4.8, 0.0);
      vBeam = vec2(aCorner.x * halfWidth, aCorner.y * 4.8);
      gl_Position = applyLens(uViewProjection * vec4(position, 1.0));
    }
  `;

  const BEAM_FRAGMENT = `#version 300 es
    precision highp float;
    in vec2 vBeam;
    uniform float uTime;
    uniform float uLight;
    uniform float uGain;
    out vec4 outColor;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }

    void main() {
      float v = vBeam.y / 4.8;
      float across = vBeam.x / mix(0.95, 0.07, v);
      float core = pow(1.0 - smoothstep(0.0, 1.0, abs(across)), 1.7);
      float falloff = smoothstep(0.0, 0.3, v) * mix(0.45, 1.0, v);
      float haze = noise(vec2(across * 3.0 + 7.0, v * 4.0 - uTime * 0.06)) * 0.5
                 + noise(vec2(across * 7.0 - uTime * 0.03, v * 9.0 + 3.0)) * 0.5;
      float intensity = core * falloff * (0.8 + 0.4 * haze);
      outColor = vec4(vec3(0.91, 0.74, 0.52) * intensity * 0.13 * uLight * uGain, 0.0);
    }
  `;

  const DUST_VERTEX = `#version 300 es
    layout(location = 1) in vec4 aSeed;
    uniform mat4 uViewProjection;
    ${LENS}
    uniform float uTime;
    uniform float uPixelScale;
    out float vBrightness;

    void main() {
      float angle = aSeed.x * 6.2831 + uTime * 0.03 * (aSeed.w - 0.5);
      float radius = 0.2 + sqrt(aSeed.y) * 2.3;
      float height = fract(aSeed.z + uTime * (0.004 + 0.01 * aSeed.w)) * 4.4;
      vec3 p = vec3(cos(angle) * radius, height, sin(angle) * radius);
      p.x += sin(uTime * 0.35 + aSeed.z * 21.0) * 0.06;
      p.z += cos(uTime * 0.29 + aSeed.y * 17.0) * 0.06;

      vec4 clip = applyLens(uViewProjection * vec4(p, 1.0));
      gl_Position = clip;

      float beamRadius = mix(0.95, 0.07, height / 4.8);
      float inBeam = 1.0 - smoothstep(beamRadius * 0.45, beamRadius * 1.2, length(p.xz));
      float fade = smoothstep(0.0, 0.5, height) * (1.0 - smoothstep(3.6, 4.4, height));
      vBrightness = (0.07 + 0.93 * inBeam) * fade * (0.35 + 0.65 * aSeed.w);
      gl_PointSize = max(1.0, (0.008 + 0.014 * aSeed.w) * uPixelScale / clip.w);
    }
  `;

  const DUST_FRAGMENT = `#version 300 es
    precision highp float;
    in float vBrightness;
    uniform float uLight;
    out vec4 outColor;

    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      outColor = vec4(vec3(1.0, 0.86, 0.66) * a * vBrightness * mix(0.15, 1.0, uLight) * 0.85, 0.0);
    }
  `;

  function createProgram(vertexSource, fragmentSource) {
    const program = gl.createProgram();
    [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]].forEach(function (pair) {
      const shader = gl.createShader(pair[0]);
      gl.shaderSource(shader, pair[1]);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      gl.attachShader(program, shader);
    });
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }

    // collect uniform locations by name: program.u.uLight, etc.
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program: program, u: uniforms };
  }

  let background, floor, figure, beam, dust;
  try {
    background = createProgram(FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT);
    floor = createProgram(FLOOR_VERTEX, FLOOR_FRAGMENT);
    figure = createProgram(FIGURE_VERTEX, FIGURE_FRAGMENT);
    beam = createProgram(BEAM_VERTEX, BEAM_FRAGMENT);
    dust = createProgram(DUST_VERTEX, DUST_FRAGMENT);
  } catch (error) {
    console.warn('Turntable: showing a still image instead.', error);
    showStillImage();
    return;
  }

  const atlasWidth = ATLAS.columns * ATLAS.cellWidth;
  const atlasHeight = ATLAS.rows * ATLAS.cellHeight;
  if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < Math.max(atlasWidth, atlasHeight)) {
    showStillImage();
    return;
  }

  /* ------------------------------------------------------------------------
     5. Geometry
     ------------------------------------------------------------------------ */

  // A unit quad (x: -1..1, y: 0..1) shared by the floor, figure and beam.
  const emptyVao = gl.createVertexArray();
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Dust motes: four random numbers each; the shader animates them.
  const DUST_COUNT = window.matchMedia('(max-width: 700px)').matches ? 140 : 260;
  const seeds = new Float32Array(DUST_COUNT * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const dustVao = gl.createVertexArray();
  gl.bindVertexArray(dustVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Figure card size in metres, from the photo's pixel size.
  const metresPerPixel = FIGURE_HEIGHT / (ATLAS.cellHeight - ATLAS.feetPx - ATLAS.headPx);
  const CARD = {
    width: ATLAS.cellWidth * metresPerPixel,
    height: ATLAS.cellHeight * metresPerPixel,
    offsetY: -ATLAS.feetPx * metresPerPixel
  };

  /* ------------------------------------------------------------------------
     6. The photo atlas
     ------------------------------------------------------------------------ */

  let atlas = null;
  let atlasLoadedAt = 0;

  const image = new Image();
  image.decoding = 'async';
  image.onload = function () {
    atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch (error) {
      // Browsers block this when the page is opened straight from disk (file://).
      console.warn('Turntable: open the site through a local server (for example "npx serve") to see it turn.', error);
      atlas = null;
      showStillImage();
      return;
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    atlasLoadedAt = performance.now();
    if (!started) start();
  };
  image.onerror = showStillImage;
  image.src = hero.dataset.turntable;

  /* ------------------------------------------------------------------------
     7. State
     ------------------------------------------------------------------------ */

  // theta: how far the stage has turned, in degrees (0 = facing you).
  // pose: which photo is shown. During eased turns it equals theta; while the
  // visitor points or drags it hops quickly from one real photo to the next.
  // Modes: intro, idle, hover, drag, glide (after a flick), settle, tween.
  const state = {
    theta: reducedMotion ? 0 : INTRO_FROM,   // camera / turntable angle
    pose: reducedMotion ? 0 : INTRO_FROM,    // angle of the photo shown
    target: 0,
    velocity: 0,
    mode: reducedMotion ? 'idle' : 'intro',
    tween: null,
    returnAt: 0,                        // when to turn back to 0 degrees (0 = not planned)

    light: reducedMotion ? 1 : 0,       // 0 = dark, 1 = lamp fully on
    distance: reducedMotion ? CAMERA.distance : 8.6,
    height: reducedMotion ? CAMERA.height : 0.5,

    pointerX: 0, pointerY: 0,           // -1..1, for gentle parallax
    parallaxX: 0, parallaxY: 0,
    scroll: 0, scrollTarget: 0
  };

  let projection = null;
  let lens = [1, 0, 0];
  let figureOnScreen = [0, 0];
  let pixelScale = 1;

  /* ------------------------------------------------------------------------
     8. Fitting the stage to the layout
     ------------------------------------------------------------------------ */

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.round(hero.clientWidth * dpr));
    const height = Math.max(1, Math.round(hero.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    projection = perspective(CAMERA.fov * DEG, width / height, 0.1, 60);

    const styles = getComputedStyle(hero);
    const figX = parseFloat(styles.getPropertyValue('--fig-x')) || 0.5;
    const figTop = parseFloat(styles.getPropertyValue('--fig-top')) || 0.15;
    const figBottom = parseFloat(styles.getPropertyValue('--fig-bottom')) || 0.78;

    // Where head and feet land with the camera at rest...
    const restView = multiply(projection, lookAt([0, CAMERA.height, CAMERA.distance], [0, CAMERA.lookAt, 0]));
    const headY = project(restView, [0, FIGURE_HEIGHT, 0])[1];
    const feetY = project(restView, [0, 0, 0])[1];

    // ...and the zoom + shift that moves them to the CSS positions.
    const wantedHeadY = 1 - 2 * figTop;
    const wantedFeetY = 1 - 2 * figBottom;
    const zoom = (wantedHeadY - wantedFeetY) / (headY - feetY);
    lens = [zoom, 2 * figX - 1, wantedFeetY - zoom * feetY];

    const chestY = project(restView, [0, 1.15, 0])[1];
    figureOnScreen = [lens[1], chestY * zoom + lens[2]];
    pixelScale = (height / 2) * projection[5] * zoom;
  }

  /* ------------------------------------------------------------------------
     9. Opening shot: dark stage, the lamp flickers on, the camera dollies in
        and the figure turns from the side to face the visitor
     ------------------------------------------------------------------------ */

  const FLICKER = [[0, 0], [0.32, 0], [0.38, 0.5], [0.46, 0.06], [0.58, 0.72],
                   [0.66, 0.22], [0.76, 0.9], [0.84, 0.55], [1.05, 1]];

  function lampAt(seconds) {
    if (seconds >= 1.05) return 1;
    for (let i = 1; i < FLICKER.length; i++) {
      if (seconds <= FLICKER[i][0]) {
        const t = (seconds - FLICKER[i - 1][0]) / (FLICKER[i][0] - FLICKER[i - 1][0]);
        return lerp(FLICKER[i - 1][1], FLICKER[i][1], t);
      }
    }
    return 1;
  }

  let introStart = 0;
  let revealed = false;

  function playIntro(now) {
    const t = (now - introStart) / 1000;
    const dolly = easeInOutCubic(clamp((t - 0.1) / 3.2, 0, 1));
    state.distance = lerp(8.6, CAMERA.distance, dolly);
    state.height = lerp(0.5, CAMERA.height, dolly);
    state.theta = state.target = lerp(INTRO_FROM, 0, easeInOutCubic(clamp((t - 0.7) / 2.7, 0, 1)));
    state.light = lampAt(t - 0.2);

    if (!revealed && t > 2.2) {
      revealed = true;
      reveal();
    }
    if (t > 3.5) {
      state.mode = 'idle';
      state.theta = state.target = state.pose = 0;
    }
  }

  /* ------------------------------------------------------------------------
     10. Turning
     ------------------------------------------------------------------------ */

  // Smooth, eased turn to an angle (used by buttons, keys and turning home).
  function turnTo(angle, duration, returnDelay) {
    const to = nearestTurn(angle, state.theta);
    state.tween = { from: state.theta, to: to, start: performance.now(), duration: duration, returnDelay: returnDelay };
    state.mode = 'tween';
    state.returnAt = 0;
  }

  function turnHome() {
    const distance = Math.abs(nearestTurn(0, state.theta) - state.theta);
    if (distance < 0.05) return;
    turnTo(0, clamp(450 + distance * 5, 500, 1300), 0);
  }

  // The visitor is interacting: finish the opening shot if it is still running.
  function takeOver() {
    hero.classList.add('has-turned');
    if (state.mode === 'intro') {
      state.mode = 'idle';
      if (!revealed) {
        revealed = true;
        reveal();
      }
    }
  }

  function update(dt, now) {
    if (state.mode === 'intro') {
      playIntro(now);
    } else if (state.mode === 'idle') {
      if (state.returnAt && now > state.returnAt) {
        state.returnAt = 0;
        turnHome();
      }
    } else if (state.mode === 'tween') {
      const tw = state.tween;
      const t = clamp((now - tw.start) / tw.duration, 0, 1);
      state.theta = state.target = lerp(tw.from, tw.to, easeInOutCubic(t));
      if (t >= 1) {
        state.mode = 'idle';
        state.returnAt = tw.returnDelay ? now + tw.returnDelay : 0;
      }
    } else if (state.mode === 'hover') {
      // the figure turns toward where the mouse points
      state.theta = follow(state.theta, state.target, 6, dt);
    } else if (state.mode === 'drag') {
      // the pointer moves the target; the figure eases after it
      state.theta = follow(state.theta, state.target, 18, dt);
    } else if (state.mode === 'glide') {
      // keep spinning after a flick, slowing down
      state.target += state.velocity * dt;
      state.velocity *= Math.exp(-dt * 3);
      state.theta = follow(state.theta, state.target, 18, dt);
      if (Math.abs(state.velocity) < 12) {
        state.target = Math.round(state.target / POSE_STEP) * POSE_STEP;
        state.mode = 'settle';
      }
    } else if (state.mode === 'settle') {
      // come to rest on the nearest real photo
      state.theta = follow(state.theta, state.target, 7, dt);
      if (Math.abs(state.target - state.theta) < 0.02) {
        state.theta = state.target;
        state.mode = 'idle';
        state.returnAt = now + RETURN_DELAY.afterDrag;
      }
    }

    // Which photo to show. Eased turns pass smoothly through every frame;
    // when the visitor drags, the figure hops quickly between real photos,
    // so it never rests on an in-between frame.
    if (state.mode === 'intro' || state.mode === 'tween') {
      state.pose = state.theta;
    } else {
      const nearestPose = Math.round(state.theta / POSE_STEP) * POSE_STEP;
      state.pose = follow(state.pose, nearestPose, 9, dt);
      if (Math.abs(nearestPose - state.pose) < 0.05) state.pose = nearestPose;
    }

    // if the intro was cut short, ease the camera and lamp home
    if (state.mode !== 'intro') {
      state.distance = follow(state.distance, CAMERA.distance, 2.2, dt);
      state.height = follow(state.height, CAMERA.height, 2.2, dt);
      state.light = follow(state.light, 1, 2.2, dt);
    }

    state.parallaxX = follow(state.parallaxX, state.pointerX, 2.5, dt);
    state.parallaxY = follow(state.parallaxY, state.pointerY, 2.5, dt);
    state.scroll = follow(state.scroll, state.scrollTarget, 6, dt);
  }

  /* ------------------------------------------------------------------------
     11. Keeping the page in sync (angle readout and the active layer)
     ------------------------------------------------------------------------ */

  let shownAngle = -1;
  let shownLayer = -1;
  let shownLabel = '';

  let shownTilt = '';

  function syncInterface() {
    // the text blocks lean gently toward the pointer (see .hero__intro in the CSS)
    const tilt = state.parallaxX.toFixed(3) + ',' + state.parallaxY.toFixed(3);
    if (tilt !== shownTilt) {
      shownTilt = tilt;
      hero.style.setProperty('--tilt-x', state.parallaxX.toFixed(3));
      hero.style.setProperty('--tilt-y', state.parallaxY.toFixed(3));
    }

    const angle = Math.round(wrapAngle(state.theta)) % 360;
    if (angle !== shownAngle) {
      shownAngle = angle;
      dialValue.textContent = angle + '°';
      dial.setAttribute('aria-valuenow', angle);
    }

    const layer = ((Math.round(state.pose / 90) % 4) + 4) % 4;
    if (layer !== shownLayer) {
      shownLayer = layer;
      layerItems.forEach(function (item, index) {
        item.classList.toggle('is-active', index === layer);
        item.querySelector('.layers__button').setAttribute('aria-pressed', String(index === layer));
      });
    }

    const name = layerItems[layer].querySelector('.layers__button').textContent.toLowerCase();
    const label = angle + ' degrees, ' + name;
    if (label !== shownLabel) {
      shownLabel = label;
      dial.setAttribute('aria-valuetext', label);
    }
  }

  /* ------------------------------------------------------------------------
     12. Input: layer buttons, keyboard, drag, parallax, scroll
     ------------------------------------------------------------------------ */

  layerItems.forEach(function (item) {
    item.querySelector('.layers__button').addEventListener('click', function () {
      takeOver();
      const angle = Number(item.dataset.angle);
      const distance = Math.abs(nearestTurn(angle, state.theta) - state.theta);
      turnTo(angle, clamp(450 + distance * 5, 500, 1300), RETURN_DELAY.afterPick);
    });
  });

  dial.addEventListener('keydown', function (event) {
    const steps = { ArrowRight: 45, ArrowUp: 45, ArrowLeft: -45, ArrowDown: -45, PageUp: 90, PageDown: -90 };
    if (!(event.key in steps) && event.key !== 'Home') return;
    event.preventDefault();
    takeOver();
    if (event.key === 'Home') {
      turnTo(0, 900, 0);
      return;
    }
    const from = state.mode === 'tween' ? state.tween.to : Math.round(state.theta / 45) * 45;
    turnTo(from + steps[event.key], 520, RETURN_DELAY.afterPick);
  });

  let drag = null;

  hero.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 || hero.classList.contains('is-static')) return;
    if (event.target.closest('a, button, .hero__intro, .layers, .site-header')) return;
    takeOver();
    drag = { id: event.pointerId, x: event.clientX, time: performance.now() };
    try { hero.setPointerCapture(event.pointerId); } catch (error) { /* synthetic events */ }
    hero.classList.add('is-dragging');
    state.mode = 'drag';
    state.target = state.theta;
    state.velocity = 0;
  });

  // Mouse: pointing at the figure turns it. Left edge of the zone = -180,
  // right edge = +180. Leaving the zone turns it back to face the visitor.
  function hoverTurn(event, box) {
    if (event.pointerType !== 'mouse' || drag || hero.classList.contains('is-static')) return;
    if (state.mode === 'intro') return;
    const figX = parseFloat(getComputedStyle(hero).getPropertyValue('--fig-x')) || 0.5;
    const zone = box.width * HOVER_ZONE;
    const offset = (event.clientX - box.left - figX * box.width) / zone;
    const overText = event.target.closest('a, button');   // links and buttons keep their own job
    if (Math.abs(offset) <= 1 && !overText) {
      if (state.mode !== 'hover') {
        takeOver();
        state.mode = 'hover';
      }
      state.target = nearestTurn(offset * 180, state.theta);
      state.returnAt = 0;
    } else if (state.mode === 'hover') {
      state.mode = 'idle';
      state.returnAt = performance.now() + RETURN_DELAY.afterHover;
    }
  }

  hero.addEventListener('pointermove', function (event) {
    const box = hero.getBoundingClientRect();
    state.pointerX = ((event.clientX - box.left) / box.width) * 2 - 1;
    state.pointerY = ((event.clientY - box.top) / box.height) * 2 - 1;
    hoverTurn(event, box);
    if (!drag || event.pointerId !== drag.id) return;

    const now = performance.now();
    const sensitivity = event.pointerType === 'touch' ? 0.55 : 0.4;   // degrees per pixel
    const delta = (event.clientX - drag.x) * sensitivity;
    state.target += delta;

    const seconds = Math.max(8, now - drag.time) / 1000;
    state.velocity = lerp(state.velocity, delta / seconds, 0.4);
    drag.x = event.clientX;
    drag.time = now;
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    // a pointer that stopped before letting go should not keep spinning
    if (performance.now() - drag.time > 90) state.velocity = 0;
    drag = null;
    hero.classList.remove('is-dragging');
    state.mode = 'glide';
  }
  hero.addEventListener('pointerup', endDrag);
  hero.addEventListener('pointercancel', endDrag);
  hero.addEventListener('pointerleave', function () {
    if (!drag) {
      state.pointerX = 0;
      state.pointerY = 0;
    }
    if (state.mode === 'hover') {
      state.mode = 'idle';
      state.returnAt = performance.now() + RETURN_DELAY.afterHover;
    }
  });

  window.addEventListener('scroll', function () {
    const box = hero.getBoundingClientRect();
    state.scrollTarget = clamp(-box.top / Math.max(1, box.height), 0, 1);
  }, { passive: true });

  /* ------------------------------------------------------------------------
     13. Drawing a frame
     ------------------------------------------------------------------------ */

  function lightFor(direction, toCamera, right, base, gain) {
    const side = direction[0] * right[0] + direction[1] * right[1];
    const behind = -(direction[0] * toCamera[0] + direction[1] * toCamera[1]);
    return [side, base + gain * smoothstep(-0.35, 1, behind)];
  }

  function render(now) {
    const time = reducedMotion ? 8 : now / 1000;

    // the camera orbits opposite to the figure's turn
    const orbit = (-state.theta + state.parallaxX * 2.2) * DEG;
    const distance = state.distance + state.scroll * 1.6;
    const height = state.height - state.parallaxY * 0.1 + state.scroll * 1.1;
    const eye = [distance * Math.sin(orbit), height, distance * Math.cos(orbit)];
    const viewProjection = multiply(projection, lookAt(eye, [0, CAMERA.lookAt + state.scroll * 0.3, 0]));

    const toCamera = [Math.sin(orbit), Math.cos(orbit)];
    const right = [Math.cos(orbit), -Math.sin(orbit)];
    const key = lightFor(KEY_LIGHT, toCamera, right, 0.16, 0.5);
    const rim = lightFor(RIM_LIGHT, toCamera, right, 0.12, 0.55);

    gl.clearColor(0.039, 0.055, 0.098, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    // background
    gl.disable(gl.BLEND);
    gl.useProgram(background.program);
    gl.uniform2f(background.u.uResolution, canvas.width, canvas.height);
    gl.uniform2f(background.u.uFigure, figureOnScreen[0], figureOnScreen[1]);
    gl.uniform1f(background.u.uLight, state.light);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // floor
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(floor.program);
    gl.uniformMatrix4fv(floor.u.uViewProjection, false, viewProjection);
    gl.uniform3fv(floor.u.uLens, lens);
    gl.uniform1f(floor.u.uLight, state.light);
    gl.uniform2f(floor.u.uShadowDirection, -KEY_LIGHT[0], -KEY_LIGHT[1]);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const opacity = atlas ? (reducedMotion ? 1 : smoothstep(0, 700, now - atlasLoadedAt)) : 0;

    function drawFigure(reflection) {
      gl.useProgram(figure.program);
      gl.uniformMatrix4fv(figure.u.uViewProjection, false, viewProjection);
      gl.uniform3fv(figure.u.uLens, lens);
      gl.uniform3fv(figure.u.uCamera, eye);
      gl.uniform2f(figure.u.uSize, CARD.width, CARD.height);
      gl.uniform1f(figure.u.uOffsetY, CARD.offsetY);
      gl.uniform1f(figure.u.uReflection, reflection ? 1 : 0);
      gl.uniform2f(figure.u.uGrid, ATLAS.columns, ATLAS.rows);
      gl.uniform1f(figure.u.uFrameCount, ATLAS.frames);
      gl.uniform2f(figure.u.uPixel, 1 / ATLAS.cellWidth, 1 / ATLAS.cellHeight);
      gl.uniform1f(figure.u.uFrame, wrapAngle(state.pose) / DEGREES_PER_FRAME);
      gl.uniform1f(figure.u.uLight, state.light);
      gl.uniform1f(figure.u.uOpacity, opacity);
      gl.uniform2fv(figure.u.uKey, key);
      gl.uniform2fv(figure.u.uRim, rim);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(figure.u.uAtlas, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function drawBeam(gain) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(beam.program);
      gl.uniformMatrix4fv(beam.u.uViewProjection, false, viewProjection);
      gl.uniform3fv(beam.u.uLens, lens);
      gl.uniform3fv(beam.u.uCamera, eye);
      gl.uniform1f(beam.u.uTime, time);
      gl.uniform1f(beam.u.uLight, state.light);
      gl.uniform1f(beam.u.uGain, gain);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // reflection in the lacquered floor
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (atlas) drawFigure(true);

    // light beam behind the figure
    drawBeam(1);

    // the figure writes depth, so dust can pass behind him
    if (atlas) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawFigure(false);
    }

    // dust in the light
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(dust.program);
    gl.uniformMatrix4fv(dust.u.uViewProjection, false, viewProjection);
    gl.uniform3fv(dust.u.uLens, lens);
    gl.uniform1f(dust.u.uTime, time);
    gl.uniform1f(dust.u.uPixelScale, pixelScale);
    gl.uniform1f(dust.u.uLight, state.light);
    gl.bindVertexArray(dustVao);
    gl.drawArrays(gl.POINTS, 0, DUST_COUNT);

    // a little haze in front
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(quadVao);
    drawBeam(0.3);
  }

  /* ------------------------------------------------------------------------
     14. Main loop (pauses when the hero is off screen)
     ------------------------------------------------------------------------ */

  let started = false;
  let visible = true;
  let frameRequest = 0;
  let lastTime = 0;

  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    update(dt, now);
    syncInterface();
    render(now);
    frameRequest = visible ? requestAnimationFrame(loop) : 0;
  }

  function start() {
    started = true;
    resize();
    lastTime = introStart = performance.now();
    if (reducedMotion) {
      revealed = true;
      reveal();
    }
    frameRequest = requestAnimationFrame(loop);
  }

  new ResizeObserver(function () {
    if (started) resize();
  }).observe(hero);

  new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting;
    if (visible && started && !frameRequest) {
      lastTime = performance.now();
      frameRequest = requestAnimationFrame(loop);
    }
  }).observe(hero);

  // if the photos are slow to arrive, open the scene without them
  setTimeout(function () {
    if (!started) start();
  }, 900);
})();