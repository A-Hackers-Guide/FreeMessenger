// Live wallpapers for chat backgrounds, drawn on the graphics chip (WebGL).
// Each scene is a small fragment shader: slow, smooth motion, rendered at a
// reduced resolution and at most 30 frames a second so it stays light on
// battery; paused while the page is hidden; a still frame when the device
// asks for less motion. Browsers without WebGL get the CSS animations.

export const SCENES = [
  ["ribbons", "✨ Ribbons"],
  ["glass", "✨ Glass"],
  ["flow", "✨ Flow"],
  ["meadow", "✨ Meadow"],
  ["coast", "✨ Coast"],
  ["silk", "✨ Silk"],
  ["northern-sky", "✨ Northern sky"],
  ["nebula", "✨ Nebula"],
  ["liquid", "✨ Liquid"],
  ["shallows", "✨ Shallows"],
  ["dunes", "✨ Dunes"],
  ["prism", "✨ Prism"],
  ["glow", "✨ Glow"],
];

const COMMON = `
precision highp float;
uniform float t;
uniform vec2 r;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * n(p); p = m * p; a *= 0.5; }
  return v;
}
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 3; i++) { v += a * n(p); p = m * p; a *= 0.5; }
  return v;
}
// A whisper of grain so smooth gradients never show steps.
vec3 dither(vec3 c) { return c + (h(gl_FragCoord.xy + fract(t)) - 0.5) / 180.0; }
`;

const FRAG = {
  // Big overlapping bands of warm color, each casting a soft shadow on the
  // one behind it, slowly swaying.
  ribbons: `
vec3 warm(float k) {
  vec3 a = vec3(1.0, 0.72, 0.28), b = vec3(0.98, 0.38, 0.40), c = vec3(0.78, 0.22, 0.62), d = vec3(0.30, 0.16, 0.62);
  return k < 0.33 ? mix(a, b, k / 0.33) : k < 0.66 ? mix(b, c, (k - 0.33) / 0.33) : mix(c, d, (k - 0.66) / 0.34);
}
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float x = uv.x * r.x / r.y;
  float tt = t * 0.06;
  vec3 col = mix(vec3(0.26, 0.12, 0.52), vec3(0.16, 0.08, 0.36), uv.y);
  for (int j = 0; j < 7; j++) {
    float i = 6.0 - float(j);
    float k = i / 6.0;
    float y0 = 0.06 + k * 0.86 + 0.15 * sin(x * (0.9 + k * 0.5) + tt * (0.8 + k * 0.6) + i * 1.9) + 0.045 * sin(x * 2.4 - tt * 1.2 + i * 3.1);
    float d = uv.y - y0;
    col *= 1.0 - 0.42 * exp(-max(d, 0.0) * 26.0) * step(0.0, d);
    float rim = exp(min(d, 0.0) * 9.0);
    vec3 band = warm(1.0 - k) * (0.80 + 0.28 * rim) + pow(rim, 10.0) * 0.10;
    col = mix(col, band, smoothstep(0.0022, -0.0022, d));
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Layers of clear blue glass rolling over each other, light catching each edge.
  glass: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float x = uv.x * r.x / r.y;
  float tt = t * 0.07;
  vec3 col = mix(vec3(0.01, 0.06, 0.24), vec3(0.10, 0.42, 0.86), pow(uv.y, 1.2));
  for (int j = 0; j < 6; j++) {
    float i = 5.0 - float(j);
    float k = i / 5.0;
    float y0 = 0.05 + k * 0.80 + 0.10 * sin(x * (1.5 - k * 0.5) + tt * (1.1 + k * 0.8) + i * 2.0) + 0.035 * sin(x * 3.4 - tt * 1.6 + i);
    float d = uv.y - y0;
    float inside = smoothstep(0.003, -0.003, d);
    vec3 tint = mix(vec3(0.62, 0.86, 1.0), vec3(0.16, 0.46, 0.96), k);
    col = mix(col, col * 0.62 + tint * 0.40, inside * 0.7);
    col += vec3(0.6, 0.86, 1.0) * exp(d * 16.0) * inside * 0.10;
    float shimmer = 0.55 + 0.45 * sin(x * 3.0 + tt * 2.5 + i * 1.3);
    col += vec3(0.92, 0.98, 1.0) * exp(-abs(d) * 140.0) * 0.55 * shimmer;
    col *= 1.0 - 0.22 * exp(-max(d, 0.0) * 30.0) * step(0.0, d);
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Wide, slow waves of cool color with soft edges.
  flow: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float x = uv.x * r.x / r.y;
  float tt = t * 0.05;
  vec3 col = vec3(0.08, 0.10, 0.30);
  for (int j = 0; j < 5; j++) {
    float i = 4.0 - float(j);
    float k = i / 4.0;
    float y0 = 0.10 + k * 0.78 + 0.18 * sin(x * (0.8 + k * 0.3) + tt * (0.7 + k * 0.5) + i * 2.4) + 0.06 * sin(x * 1.9 + tt + i * 1.1);
    float d = uv.y - y0;
    vec3 c = mix(vec3(0.22, 0.85, 0.95), vec3(0.42, 0.30, 0.95), k);
    c = mix(c, vec3(0.95, 0.45, 0.85), 0.25 * (0.5 + 0.5 * sin(x * 0.7 + i + tt)));
    c *= 0.82 + 0.25 * exp(min(d, 0.0) * 6.0);
    col *= 1.0 - 0.25 * exp(-max(d, 0.0) * 14.0) * step(0.0, d);
    col = mix(col, c, smoothstep(0.012, -0.012, d));
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Rolling green hills under a soft sky; cloud shadows drift across them.
  meadow: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float a = r.x / r.y;
  float x = uv.x * a;
  vec3 col = mix(vec3(0.86, 0.92, 0.98), vec3(0.36, 0.60, 0.92), pow(uv.y, 0.9));
  float cl = fbm3(vec2(x * 1.4 + t * 0.012, uv.y * 3.0));
  col = mix(col, vec3(1.0), smoothstep(0.55, 0.78, cl) * smoothstep(0.45, 0.85, uv.y) * 0.8);
  for (int j = 0; j < 5; j++) {
    float i = float(j);
    float k = i / 4.0;
    float base = 0.52 - k * 0.11;
    float hx = x * (0.9 + k * 0.6) + i * 3.7 + t * 0.004 * (1.0 + k);
    float hgt = base + 0.07 * sin(hx * 1.2) + 0.04 * sin(hx * 2.7 + 1.0) + 0.02 * fbm3(vec2(hx, i));
    float slope = 0.084 * cos(hx * 1.2) + 0.108 * cos(hx * 2.7 + 1.0);
    vec3 grass = mix(vec3(0.56, 0.74, 0.36), vec3(0.18, 0.40, 0.20), k);
    grass *= 0.86 + 0.22 * clamp(-slope * 3.0 + 0.5, 0.0, 1.0);
    float shadow = smoothstep(0.45, 0.7, fbm3(vec2(x * 1.4 + t * 0.012, uv.y * 3.0 + 7.0)));
    grass *= 1.0 - 0.22 * shadow;
    grass = mix(grass, col, 0.18 * (1.0 - k));
    col = mix(col, grass, smoothstep(hgt + 0.002, hgt - 0.002, uv.y));
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // A sunset over the sea: a glittering path of light, gentle swell, slow clouds.
  coast: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float a = r.x / r.y;
  float x = uv.x * a;
  float horizon = 0.42;
  vec2 sun = vec2(0.62 * a, 0.52);
  vec3 col;
  if (uv.y > horizon) {
    float sy = (uv.y - horizon) / (1.0 - horizon);
    col = mix(vec3(1.0, 0.62, 0.38), vec3(0.30, 0.34, 0.62), pow(sy, 0.7));
    float d = length(vec2(x, uv.y) - sun);
    col += vec3(1.0, 0.75, 0.45) * exp(-d * 6.0) * 0.7 + vec3(1.0, 0.95, 0.8) * smoothstep(0.045, 0.040, d);
    float cl = fbm3(vec2(x * 1.6 + t * 0.01, sy * 5.0));
    col = mix(col, vec3(1.0, 0.70, 0.62) * 0.95, smoothstep(0.55, 0.8, cl) * 0.55 * sy);
  } else {
    float dy = horizon - uv.y;
    float depth = dy / horizon;
    col = mix(vec3(0.92, 0.52, 0.42), vec3(0.06, 0.12, 0.30), pow(depth, 0.55));
    float sw = sin(x * 9.0 / (0.06 + dy) - t * 0.9) * 0.5 + 0.5;
    col *= 0.92 + 0.08 * sw;
    float path = exp(-abs(x - sun.x) * (3.0 + 18.0 * depth));
    float glint = pow(n(vec2(x * 60.0 / (0.05 + dy), uv.y * 400.0 - t * 2.0)), 6.0);
    col += vec3(1.0, 0.85, 0.6) * path * (0.25 + 1.6 * glint);
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Folds of silk: noise warped by noise, in deep blue to rose to cream.
  silk: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  vec2 p = uv * vec2(r.x / r.y, 1.0) * 0.9;
  float tt = t * 0.035;
  vec2 q = vec2(fbm3(p + tt), fbm3(p + vec2(5.2, 1.3) - tt));
  vec2 w = vec2(fbm3(p + 2.2 * q + vec2(1.7, 9.2) + tt * 1.3), fbm3(p + 2.2 * q + vec2(8.3, 2.8) - tt));
  float f = fbm3(p + 2.2 * w);
  vec3 col = mix(vec3(0.06, 0.09, 0.32), vec3(0.42, 0.20, 0.72), smoothstep(0.2, 0.62, f));
  col = mix(col, vec3(0.94, 0.44, 0.60), smoothstep(0.45, 0.85, length(q) * 0.9));
  col = mix(col, vec3(1.0, 0.84, 0.66), smoothstep(0.78, 1.08, w.x * f * 1.65));
  col += pow(max(0.0, 1.0 - abs(f - 0.55) * 5.0), 3.0) * 0.12;
  col *= 0.86 + 0.14 * uv.y;
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Ribbons of green and violet light over a dark sky and a mountain line.
  "northern-sky": `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  vec2 p = vec2(uv.x * r.x / r.y, uv.y);
  vec3 col = mix(vec3(0.01, 0.02, 0.06), vec3(0.02, 0.07, 0.16), uv.y);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (1.2 + fi * 0.3) + t * (0.03 + fi * 0.01);
    float y = 0.56 + 0.12 * sin(x * 1.3 + fi * 2.0) + 0.08 * fbm(vec2(x * 1.5, t * 0.05 + fi));
    float d = p.y - y;
    float curtain = exp(-abs(d) * (9.0 - fi * 2.0)) * smoothstep(-0.36, 0.0, d);
    float rays = 0.55 + 0.45 * fbm(vec2(x * 6.0, p.y * 1.5 - t * 0.1 + fi));
    vec3 tint = mix(vec3(0.1, 1.0, 0.62), vec3(0.55, 0.32, 1.0), clamp(fi * 0.45 + 0.2 * sin(x + t * 0.1), 0.0, 1.0));
    col += tint * curtain * rays * (0.55 - fi * 0.12);
  }
  vec2 g = floor(gl_FragCoord.xy / 2.0);
  col += step(0.9975, h(g)) * (0.5 + 0.5 * sin(t * 2.0 + h(g + 3.0) * 30.0)) * smoothstep(0.3, 1.0, uv.y);
  float m = 0.17 + 0.06 * fbm(vec2(p.x * 2.0, 1.0)) + 0.025 * sin(p.x * 7.0);
  col = mix(col, vec3(0.0, 0.01, 0.02), smoothstep(m + 0.004, m - 0.004, uv.y));
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Glowing gas clouds with two layers of stars drifting at different speeds.
  nebula: `
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * r) / r.y;
  float tt = t * 0.02;
  vec2 q = p * 1.8 + vec2(tt, tt * 0.5);
  float f = fbm(q + fbm(q * 1.7 - tt));
  float g = fbm(q * 2.3 + vec2(4.0, -tt));
  vec3 col = vec3(0.01, 0.01, 0.03);
  col += vec3(0.36, 0.12, 0.56) * pow(f, 2.2) * 1.7;
  col += vec3(0.05, 0.36, 0.62) * pow(g, 3.0) * 1.5;
  col += vec3(0.95, 0.52, 0.32) * pow(f * g, 4.0) * 2.2;
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 sp = gl_FragCoord.xy / (1.5 + fl) + vec2(t * (1.0 + fl * 2.0), 0.0);
    vec2 gi = floor(sp);
    vec2 gf = fract(sp) - 0.5;
    float s = h(gi + fl * 7.0);
    if (s > 0.996) col += vec3(1.0) * (0.6 + 0.4 * sin(t * 3.0 + s * 100.0)) * smoothstep(0.5, 0.0, length(gf)) * (1.0 - fl * 0.4);
  }
  col = 1.0 - exp(-col * 1.4);
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Soft glossy drops that drift, touch and melt into each other.
  liquid: `
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * r) / r.y;
  float v = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * 0.09 * (1.0 + fi * 0.2) + fi * 1.7) * 0.42 * (r.x / r.y), cos(t * 0.08 * (1.0 + fi * 0.15) + fi * 2.3) * 0.32);
    float rad = 0.19 + 0.06 * sin(fi * 3.1 + t * 0.15);
    v += rad * rad / max(dot(p - c, p - c), 0.0001);
  }
  vec3 bg = mix(vec3(0.94, 0.95, 1.0), vec3(0.80, 0.85, 0.98), gl_FragCoord.y / r.y);
  float inside = smoothstep(0.96, 1.06, v);
  vec3 base = mix(vec3(0.33, 0.45, 1.0), vec3(0.88, 0.40, 0.90), 0.5 + 0.5 * sin(p.x * 2.0 + p.y + t * 0.1));
  float depth = clamp((v - 1.0) / 2.5, 0.0, 1.0);
  vec3 col = mix(bg, base * (0.72 + 0.4 * depth), inside);
  col += inside * pow(1.0 - depth, 6.0) * 0.45;
  col += inside * smoothstep(0.6, 1.0, depth) * 0.15;
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Sunlight dancing on the floor of clear shallow water, with soft rays.
  shallows: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  vec2 p = uv * vec2(r.x / r.y, 1.0) * 5.0;
  vec2 q = p;
  float c = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    q += vec2(sin(q.y * 1.3 + t * 0.32 + fk), cos(q.x * 1.1 - t * 0.27 + fk * 1.7)) * 0.62;
    c += 1.0 / (1.0 + 22.0 * abs(sin(q.x) * sin(q.y)));
  }
  float caust = pow(c / 3.0, 2.2);
  vec3 col = mix(vec3(0.0, 0.17, 0.30), vec3(0.04, 0.50, 0.62), uv.y);
  col += vec3(0.55, 0.95, 0.95) * caust * 0.55;
  float ray = fbm(vec2(uv.x * 5.0 + uv.y * 1.6, t * 0.05)) * smoothstep(0.0, 1.0, uv.y);
  col += vec3(0.25, 0.55, 0.62) * pow(ray, 3.0) * 0.7;
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Layers of dunes sliding past at different speeds under a warm sky.
  dunes: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float a = r.x / r.y;
  vec3 col = mix(vec3(1.0, 0.72, 0.55), vec3(0.42, 0.36, 0.72), pow(uv.y, 0.8));
  float d = length(vec2(uv.x * a, uv.y) - vec2(0.72 * a, 0.64));
  col += vec3(1.0, 0.8, 0.5) * exp(-d * 7.0) * 0.8 + vec3(1.0, 0.92, 0.72) * smoothstep(0.06, 0.05, d);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = uv.x * a * (1.0 + fi * 0.4) + t * (0.01 + fi * 0.012) + fi * 10.0;
    float hgt = 0.42 - fi * 0.09 + 0.06 * sin(x * 1.3) + 0.04 * fbm(vec2(x * 0.8, fi));
    vec3 tone = mix(vec3(0.88, 0.56, 0.46), vec3(0.24, 0.14, 0.30), fi / 3.0);
    tone += 0.09 * smoothstep(0.045, 0.0, hgt - uv.y);
    col = mix(col, tone, smoothstep(hgt + 0.003, hgt - 0.003, uv.y));
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Pastel light bending through glass, like the colors on a soap film.
  prism: `
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * r) / r.y;
  float tt = t * 0.04;
  float f = fbm(p * 1.2 + vec2(tt, -tt)) * 2.0 + p.x * 0.6 + p.y * 0.3;
  vec3 col = 0.55 + 0.45 * cos(6.2831 * (f * 0.6 + vec3(0.0, 0.33, 0.67) + tt));
  col = mix(vec3(0.97), col, 0.55);
  col += pow(0.5 + 0.5 * sin(f * 9.0), 6.0) * 0.07;
  gl_FragColor = vec4(dither(col), 1.0);
}`,
  // Out-of-focus city lights floating at three depths.
  glow: `
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  vec2 p = gl_FragCoord.xy / r.y;
  vec3 col = mix(vec3(0.05, 0.03, 0.12), vec3(0.16, 0.05, 0.21), uv.y);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    vec2 q = p * (3.0 + fl * 2.0) + vec2(t * 0.02 * (1.0 + fl), t * (0.05 + fl * 0.03));
    vec2 gi = floor(q);
    vec2 gf = fract(q) - 0.5;
    float rnd = h(gi + fl * 13.0);
    if (rnd > 0.55) {
      vec2 off = (vec2(h(gi + 1.0), h(gi + 2.0)) - 0.5) * 0.5;
      float rad = 0.18 + 0.15 * h(gi + 3.0);
      vec3 tint = mix(vec3(1.0, 0.56, 0.30), vec3(0.42, 0.62, 1.0), h(gi + 4.0));
      float a = smoothstep(rad, rad - 0.05 / (1.0 + fl), length(gf - off)) * (0.36 - fl * 0.08) * (0.6 + 0.4 * sin(t * 0.5 + rnd * 20.0));
      col += tint * a;
    }
  }
  gl_FragColor = vec4(dither(col), 1.0);
}`,
};

// Light scenes need dark text on top; the rest are dark.
export const LIGHT_SCENES = new Set(["liquid", "prism", "dunes", "meadow"]);

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";

let running = null; // { key, canvas, gl, raf, ... }

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
  return s;
}

export const isScene = (key) => SCENES.some((s) => s[0] === key);

export function supported() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

// Starts a scene filling `layer`. Returns false if this browser can't.
export function start(layer, key) {
  if (running && running.key === key && running.canvas.parentNode === layer) return true;
  stop();
  if (!FRAG[key]) return false;
  const canvas = document.createElement("canvas");
  canvas.className = "bgfx";
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, powerPreference: "low-power", premultipliedAlpha: false })
    || canvas.getContext("experimental-webgl");
  if (!gl) return false;
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, COMMON + FRAG[key]));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
  } catch {
    return false;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uT = gl.getUniformLocation(prog, "t");
  const uR = gl.getUniformLocation(prog, "r");
  layer.appendChild(canvas);
  const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // A random start, so two chats with the same scene don't look identical.
  const offset = 40 + Math.random() * 400;
  const t0 = performance.now();
  let last = 0;
  const size = () => {
    const rect = layer.getBoundingClientRect();
    // Soft scenes look the same at lower resolution, and cost far less.
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 0.55;
    const w = Math.max(1, Math.round(rect.width * scale));
    const hh = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width !== w || canvas.height !== hh) {
      canvas.width = w;
      canvas.height = hh;
      gl.viewport(0, 0, w, hh);
    }
  };
  const draw = (now) => {
    if (!running || running.canvas !== canvas) return;
    running.raf = requestAnimationFrame(draw);
    if (document.hidden || now - last < 33) return;
    last = now;
    size();
    gl.uniform1f(uT, offset + (still ? 0 : (now - t0) / 1000));
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (still) { cancelAnimationFrame(running.raf); }
  };
  running = { key, canvas, gl, raf: requestAnimationFrame(draw) };
  size();
  gl.uniform1f(uT, offset);
  gl.uniform2f(uR, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); });
  return true;
}

export function stop() {
  if (!running) return;
  cancelAnimationFrame(running.raf);
  const lose = running.gl.getExtension && running.gl.getExtension("WEBGL_lose_context");
  if (lose) lose.loseContext();
  running.canvas.remove();
  running = null;
}
