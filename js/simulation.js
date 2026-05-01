'use strict';

/**
 * HeatSimulation — 2-D incompressible fluid with buoyancy-driven convection.
 *
 * Pipeline per step:
 *   1. Buoyancy + viscous damping  (body force on vx/vy)
 *   2. Curl-noise turbulence       (optional divergence-free perturbation)
 *   3. Velocity self-advection     (semi-Lagrangian, unconditionally stable)
 *   4. Pressure projection         (Gauss-Seidel Poisson, removes divergence)
 *   5. Vorticity confinement       (amplifies vortex structures)
 *   6. Velocity clamping
 *   7. Temperature advection       (semi-Lagrangian)
 *   8. Temperature diffusion       (explicit finite-difference, sub-stepped)
 *   9. Heat sources
 *  10. Ambient cooling / clamping
 */
class HeatSimulation {
    constructor(width, height) {
        this.width  = width;
        this.height = height;
        const n = width * height;

        // Temperature field
        this.T        = new Float32Array(n);
        this.T_buf    = new Float32Array(n);
        this.T_tmp    = new Float32Array(n);

        // Velocity field (persistent, carries momentum)
        this.vx       = new Float32Array(n);
        this.vy       = new Float32Array(n);
        this.vx_buf   = new Float32Array(n);
        this.vy_buf   = new Float32Array(n);

        // Pressure-solve buffers
        this.pressure = new Float32Array(n);
        this.div_buf  = new Float32Array(n);

        // Vorticity scratch
        this.vort_buf = new Float32Array(n);

        // Turbulence scratch (precomputed x-strips, avoids per-step alloc)
        this._sinAx = new Float32Array(width);
        this._cosAx = new Float32Array(width);
        this._sinBx = new Float32Array(width);
        this._cosBx = new Float32Array(width);

        // Physics parameters (matched to UI defaults)
        this.alpha      = 0.15;   // thermal diffusivity
        this.gravity    = 0.80;   // buoyancy strength
        this.decay      = 0.002;  // ambient cooling rate
        this.viscosity  = 0.08;   // velocity damping coefficient (per unit time)
        this.vortConf   = 0.80;   // vorticity confinement strength
        this.turbulence = 0.00;   // curl-noise turbulence amplitude
        this.dt         = 0.16;   // simulation time-step

        this.time     = 0;
        this.sources  = [];
        this._nextId  = 0;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    addSource(x, y, temperature) {
        x = Math.round(x);
        y = Math.round(y);
        for (const s of this.sources) {
            if (Math.hypot(s.x - x, s.y - y) < 3) return s;
        }
        const src = { id: this._nextId++, x, y, temperature, radius: 4, strength: 0.50 };
        this.sources.push(src);
        return src;
    }

    removeNearestSource(x, y, maxDist = 20) {
        if (!this.sources.length) return false;
        let best = null, bestDist = Infinity;
        for (const s of this.sources) {
            const d = Math.hypot(s.x - x, s.y - y);
            if (d < bestDist) { bestDist = d; best = s; }
        }
        if (best && bestDist <= maxDist) {
            this.sources = this.sources.filter(s => s.id !== best.id);
            return true;
        }
        return false;
    }

    step() {
        this._addBuoyancy();
        if (this.turbulence > 1e-4) this._addTurbulence();
        this._advectVelocity();
        this._project(10);
        if (this.vortConf > 1e-4) this._applyVorticity();
        this._clampVelocity(8.0);
        this._advectTemperature();
        this._diffuse();
        this._applySources();
        this._applyDecay();
        this.time += this.dt;
    }

    reset() {
        this.T.fill(0);
        this.vx.fill(0);
        this.vy.fill(0);
        this.pressure.fill(0);
        this.sources = [];
        this.time = 0;
    }

    clearField() {
        this.T.fill(0);
        this.vx.fill(0);
        this.vy.fill(0);
    }

    // ── Physics steps ───────────────────────────────────────────────────────

    /**
     * Apply buoyancy as a body force: hot fluid rises (vy < 0),
     * horizontal temperature gradient drives vx.  Also applies viscous damping.
     */
    _addBuoyancy() {
        const { width: W, height: H, T, vx, vy, gravity, viscosity, dt } = this;
        const damp = 1.0 - viscosity * dt;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const Tl = x > 0     ? T[y * W + x - 1] : T[i];
                const Tr = x < W - 1 ? T[y * W + x + 1] : T[i];
                // hot T > 0 → negative vy (screen y=0 is top → upward)
                vy[i] = vy[i] * damp - gravity * T[i] * dt;
                vx[i] = vx[i] * damp - 0.25 * gravity * (Tr - Tl) * dt;
            }
        }
    }

    /**
     * Add divergence-free curl-noise turbulence.
     * Uses two octaves of a separable trig potential; x-strips are precomputed
     * outside the inner loop for efficiency.
     *
     * Potential P = sin(a·x + pt) · cos(c·y + qt)
     * Divergence-free velocity: vx = ∂P/∂y = -c·sin(ax)·sin(cy)
     *                           vy = -∂P/∂x = -a·cos(ax)·cos(cy)
     */
    _addTurbulence() {
        const { width: W, height: H, vx, vy, turbulence, dt, time: t,
                _sinAx, _cosAx, _sinBx, _cosBx } = this;
        const scale = turbulence * dt * 12;

        // Octave 1 (x part)
        const a1 = 0.090, pt1 =  t * 0.41;
        // Octave 2 (x part)
        const a2 = 0.175, pt2 = -t * 0.27;
        for (let x = 0; x < W; x++) {
            _sinAx[x] = Math.sin(a1 * x + pt1);
            _cosAx[x] = Math.cos(a1 * x + pt1);
            _sinBx[x] = Math.sin(a2 * x + pt2);
            _cosBx[x] = Math.cos(a2 * x + pt2);
        }

        const c1 = 0.080, qt1 = -t * 0.35;
        const c2 = 0.140, qt2 =  t * 0.19;
        for (let y = 0; y < H; y++) {
            const sinCy1 = Math.sin(c1 * y + qt1);
            const cosCy1 = Math.cos(c1 * y + qt1);
            const sinCy2 = Math.sin(c2 * y + qt2);
            const cosCy2 = Math.cos(c2 * y + qt2);
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                vx[i] += scale * (-c1 * _sinAx[x] * sinCy1 - 0.5 * c2 * _sinBx[x] * sinCy2);
                vy[i] += scale * (-a1 * _cosAx[x] * cosCy1 - 0.5 * a2 * _cosBx[x] * cosCy2);
            }
        }
    }

    /** Semi-Lagrangian velocity self-advection (unconditionally stable). */
    _advectVelocity() {
        const { width: W, height: H, vx, vy, vx_buf, vy_buf, dt } = this;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const px = x - dt * vx[i];
                const py = y - dt * vy[i];
                vx_buf[i] = this._sample(vx, px, py);
                vy_buf[i] = this._sample(vy, px, py);
            }
        }
        vx.set(vx_buf);
        vy.set(vy_buf);
    }

    /**
     * Gauss-Seidel pressure projection.
     * Solves ∇²p = ∇·v, then subtracts ∇p from velocity to enforce ∇·v ≈ 0.
     * Neumann BCs (∂p/∂n = 0) at all walls.
     */
    _project(iters) {
        const { width: W, height: H, vx, vy, pressure, div_buf } = this;

        // Compute divergence using Neumann BCs for velocity
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const vxr = x < W - 1 ? vx[y * W + x + 1] : vx[i];
                const vxl = x > 0     ? vx[y * W + x - 1] : vx[i];
                const vyd = y < H - 1 ? vy[(y + 1) * W + x] : vy[i];
                const vyu = y > 0     ? vy[(y - 1) * W + x] : vy[i];
                div_buf[i] = -0.5 * (vxr - vxl + vyd - vyu);
            }
        }

        // Gauss-Seidel iterations (Neumann BC: ghost cell = current cell value)
        pressure.fill(0);
        for (let iter = 0; iter < iters; iter++) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = y * W + x;
                    const pl = x > 0     ? pressure[y * W + x - 1] : pressure[i];
                    const pr = x < W - 1 ? pressure[y * W + x + 1] : pressure[i];
                    const pu = y > 0     ? pressure[(y - 1) * W + x] : pressure[i];
                    const pd = y < H - 1 ? pressure[(y + 1) * W + x] : pressure[i];
                    pressure[i] = (pl + pr + pu + pd + div_buf[i]) * 0.25;
                }
            }
        }

        // Subtract pressure gradient
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const pr = x < W - 1 ? pressure[y * W + x + 1] : pressure[i];
                const pl = x > 0     ? pressure[y * W + x - 1] : pressure[i];
                const pd = y < H - 1 ? pressure[(y + 1) * W + x] : pressure[i];
                const pu = y > 0     ? pressure[(y - 1) * W + x] : pressure[i];
                vx[i] -= 0.5 * (pr - pl);
                vy[i] -= 0.5 * (pd - pu);
            }
        }
    }

    /**
     * Vorticity confinement — amplifies existing vortex cores.
     * ω = ∂vy/∂x − ∂vx/∂y  (scalar z-vorticity in 2-D)
     * F_conf = ε · ω · N⊥   where N = normalize(∇|ω|)
     */
    _applyVorticity() {
        const { width: W, height: H, vx, vy, vort_buf, vortConf, dt } = this;

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const vyr = x < W - 1 ? vy[y * W + x + 1] : vy[i];
                const vyl = x > 0     ? vy[y * W + x - 1] : vy[i];
                const vxd = y < H - 1 ? vx[(y + 1) * W + x] : vx[i];
                const vxu = y > 0     ? vx[(y - 1) * W + x] : vx[i];
                vort_buf[i] = 0.5 * ((vyr - vyl) - (vxd - vxu));
            }
        }

        const eps = vortConf * dt;
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const i = y * W + x;
                const dOx = 0.5 * (Math.abs(vort_buf[y * W + x + 1]) - Math.abs(vort_buf[y * W + x - 1]));
                const dOy = 0.5 * (Math.abs(vort_buf[(y + 1) * W + x]) - Math.abs(vort_buf[(y - 1) * W + x]));
                const len = Math.sqrt(dOx * dOx + dOy * dOy) + 1e-5;
                const nx = dOx / len;
                const ny = dOy / len;
                const omega = vort_buf[i];
                // 2-D cross: (nx,ny,0) × (0,0,ω) = (ny·ω, -nx·ω, 0)
                vx[i] += eps * omega * ny;
                vy[i] -= eps * omega * nx;
            }
        }
    }

    _clampVelocity(maxV) {
        const { vx, vy } = this;
        for (let i = 0; i < vx.length; i++) {
            if (vx[i] >  maxV) vx[i] =  maxV; else if (vx[i] < -maxV) vx[i] = -maxV;
            if (vy[i] >  maxV) vy[i] =  maxV; else if (vy[i] < -maxV) vy[i] = -maxV;
        }
    }

    /** Semi-Lagrangian temperature advection using the full velocity field. */
    _advectTemperature() {
        const { width: W, height: H, T, T_buf, vx, vy, dt } = this;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                T_buf[i] = this._sample(T, x - dt * vx[i], y - dt * vy[i]);
            }
        }
        T.set(T_buf);
    }

    /** Explicit finite-difference diffusion with adaptive sub-stepping. */
    _diffuse() {
        const { width: W, height: H, T, T_buf, T_tmp, alpha, dt } = this;
        const n_sub  = Math.max(1, Math.ceil(alpha * dt / 0.24));
        const dt_sub = dt / n_sub;
        const coeff  = alpha * dt_sub;

        T_tmp.set(T);
        for (let s = 0; s < n_sub; s++) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = y * W + x;
                    const l = x > 0     ? T_tmp[y * W + x - 1] : T_tmp[i];
                    const r = x < W - 1 ? T_tmp[y * W + x + 1] : T_tmp[i];
                    const u = y > 0     ? T_tmp[(y - 1) * W + x] : T_tmp[i];
                    const d = y < H - 1 ? T_tmp[(y + 1) * W + x] : T_tmp[i];
                    T_buf[i] = T_tmp[i] + coeff * (l + r + u + d - 4.0 * T_tmp[i]);
                }
            }
            T_tmp.set(T_buf);
        }
        T.set(T_tmp);
    }

    _applySources() {
        const { width: W, height: H, T } = this;
        for (const src of this.sources) {
            const r = src.radius;
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (dx * dx + dy * dy <= r * r) {
                        const px = src.x + dx, py = src.y + dy;
                        if (px >= 0 && px < W && py >= 0 && py < H) {
                            const i = py * W + px;
                            T[i] += src.strength * (src.temperature - T[i]);
                        }
                    }
                }
            }
        }
    }

    _applyDecay() {
        const { T, decay } = this;
        const factor = 1.0 - decay;
        for (let i = 0; i < T.length; i++) {
            let v = T[i] * factor;
            if (v >  1.5) v =  1.5;
            if (v < -1.0) v = -1.0;
            T[i] = v;
        }
    }

    /** Bilinear interpolation with clamped-boundary access. */
    _sample(arr, x, y) {
        const W = this.width, H = this.height;
        if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
        if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 + 1 < W ? x0 + 1 : x0;
        const y1 = y0 + 1 < H ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        return (1 - fx) * (1 - fy) * arr[y0 * W + x0]
             +       fx * (1 - fy) * arr[y0 * W + x1]
             + (1 - fx) *       fy * arr[y1 * W + x0]
             +       fx *       fy * arr[y1 * W + x1];
    }
}
