'use strict';

class HeatSimulation {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        const n = width * height;

        this.T     = new Float32Array(n);
        this.T_buf = new Float32Array(n);
        this.T_tmp = new Float32Array(n);
        this.vx    = new Float32Array(n);
        this.vy    = new Float32Array(n);

        this.alpha   = 0.15;   // diffusion coefficient
        this.gravity = 0.8;    // buoyancy strength
        this.decay   = 0.002;  // ambient cooling rate
        this.dt      = 0.16;   // time step

        this.sources  = [];
        this._nextId  = 0;
    }

    addSource(x, y, temperature) {
        x = Math.round(x);
        y = Math.round(y);
        // Avoid duplicates too close together
        for (const s of this.sources) {
            if (Math.hypot(s.x - x, s.y - y) < 3) return s;
        }
        const src = { id: this._nextId++, x, y, temperature, radius: 4, strength: 0.45 };
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
        this._computeVelocity();
        this._advect();
        this._diffuse();
        this._applySources();
        this._applyDecay();
    }

    // Buoyancy velocity: hot rises, cold sinks. Horizontal: pressure from ∂T/∂x.
    _computeVelocity() {
        const { width: W, height: H, T, vx, vy, gravity } = this;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                vy[i] = -gravity * T[i];
                const Tl = x > 0     ? T[y * W + x - 1] : T[i];
                const Tr = x < W - 1 ? T[y * W + x + 1] : T[i];
                vx[i] = -0.3 * gravity * (Tr - Tl) * 0.5;
            }
        }
    }

    // Semi-Lagrangian advection: unconditionally stable.
    _advect() {
        const { width: W, height: H, T, T_buf, vx, vy, dt } = this;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                T_buf[i] = this._sample(T, x - dt * vx[i], y - dt * vy[i]);
            }
        }
        T.set(T_buf);
    }

    // Explicit finite-difference diffusion with sub-stepping for stability.
    _diffuse() {
        const { width: W, height: H, T, T_buf, T_tmp, alpha, dt } = this;
        // Stability: alpha * dt_sub ≤ 0.25  (with dx=1)
        const n_sub = Math.max(1, Math.ceil(alpha * dt / 0.24));
        const dt_sub = dt / n_sub;
        const coeff = alpha * dt_sub;

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

    _sample(arr, x, y) {
        const W = this.width, H = this.height;
        if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
        if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 + 1 < W ? x0 + 1 : x0;
        const y1 = y0 + 1 < H ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        return (1 - fx) * (1 - fy) * arr[y0 * W + x0]
             +      fx  * (1 - fy) * arr[y0 * W + x1]
             + (1 - fx) *      fy  * arr[y1 * W + x0]
             +      fx  *      fy  * arr[y1 * W + x1];
    }

    reset() {
        this.T.fill(0);
        this.sources = [];
    }

    clearField() {
        this.T.fill(0);
    }
}
