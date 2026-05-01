'use strict';

class HeatRenderer {
    constructor(canvas, simWidth, simHeight) {
        this.canvas    = canvas;
        this.ctx       = canvas.getContext('2d');
        this.simWidth  = simWidth;
        this.simHeight = simHeight;

        // Visualisation toggles (all off by default for a clean first view)
        this.showVectors   = false;
        this.showSources   = false;
        this.vectorSpacing = 12;
        this.vectorScale   = 1.0;   // multiplier for arrow length

        // Temperature display range
        this.tMin = -1.0;
        this.tMax =  1.0;

        // Pre-built colour lookup table for fast pixel colouring
        this.LUT_SIZE = 1024;
        this.colorLUT = this._buildColorLUT();

        // Off-screen canvas for pixel-level temperature rendering
        this.offscreen       = document.createElement('canvas');
        this.offscreen.width  = simWidth;
        this.offscreen.height = simHeight;
        this.offCtx          = this.offscreen.getContext('2d');
        this.offImageData    = this.offCtx.createImageData(simWidth, simHeight);
    }

    /**
     * Diverging colourmap:
     *   cold (deep blue) → ambient (near-black) → hot (crimson → orange → white)
     */
    _buildColorLUT() {
        const N    = this.LUT_SIZE;
        const lut  = new Uint8Array(N * 4);
        const keys = [
            [0.00,  20, 100, 255],  // tMin   – deep blue
            [0.18,   0,  20, 180],  // –0.64  – mid blue
            [0.38,   0,   0,  30],  // –0.24  – near-black blue
            [0.50,   0,   0,   6],  // 0      – ambient
            [0.60,  55,   0,  50],  // +0.20  – dark purple
            [0.70, 190,   0,  12],  // +0.40  – dark crimson
            [0.80, 255,  70,   0],  // +0.60  – orange
            [0.88, 255, 200,   0],  // +0.76  – yellow
            [0.94, 255, 255, 140],  // +0.88  – pale yellow
            [1.00, 255, 255, 255],  // tMax   – white
        ];

        for (let i = 0; i < N; i++) {
            const f = i / (N - 1);
            let k0 = keys[0], k1 = keys[1];
            for (let j = 0; j < keys.length - 1; j++) {
                if (f >= keys[j][0] && f <= keys[j + 1][0]) {
                    k0 = keys[j]; k1 = keys[j + 1]; break;
                }
            }
            const span = k1[0] - k0[0];
            const t    = span > 0 ? (f - k0[0]) / span : 0;
            lut[i * 4]     = Math.round(k0[1] + t * (k1[1] - k0[1]));
            lut[i * 4 + 1] = Math.round(k0[2] + t * (k1[2] - k0[2]));
            lut[i * 4 + 2] = Math.round(k0[3] + t * (k1[3] - k0[3]));
            lut[i * 4 + 3] = 255;
        }
        return lut;
    }

    render(sim) {
        this._renderField(sim);
        if (this.showVectors) this._renderVectors(sim);
        if (this.showSources) this._renderSources(sim);
    }

    // ── Private rendering methods ───────────────────────────────────────────

    _renderField(sim) {
        const { width: W, height: H, T } = sim;
        const data  = this.offImageData.data;
        const lut   = this.colorLUT;
        const N     = this.LUT_SIZE - 1;
        const range = this.tMax - this.tMin;
        const tMin  = this.tMin;

        for (let i = 0; i < W * H; i++) {
            const f   = (T[i] - tMin) / range;
            const idx = (f <= 0 ? 0 : f >= 1 ? N : (f * N) | 0) * 4;
            const p   = i * 4;
            data[p]     = lut[idx];
            data[p + 1] = lut[idx + 1];
            data[p + 2] = lut[idx + 2];
            data[p + 3] = 255;
        }

        this.offCtx.putImageData(this.offImageData, 0, 0);
        this.ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
    }

    _renderVectors(sim) {
        const { width: W, height: H, vx, vy } = sim;
        const ctx = this.ctx;
        const cW  = this.canvas.width;
        const cH  = this.canvas.height;
        const sx  = cW / W;
        const sy  = cH / H;
        const sp  = this.vectorSpacing;
        const maxLen = sp * 0.65 * this.vectorScale;

        ctx.lineWidth = 1;

        for (let gy = sp >> 1; gy < H; gy += sp) {
            for (let gx = sp >> 1; gx < W; gx += sp) {
                const i  = gy * W + gx;
                const u  = vx[i];
                const v  = vy[i];
                const mag = Math.sqrt(u * u + v * v);
                if (mag < 0.04) continue;

                // Project velocity into canvas-pixel space
                const ux = u * sx;
                const uy = v * sy;
                const canvasMag = Math.sqrt(ux * ux + uy * uy);
                // Scale to maxLen, preserving direction; min-length of 2px for visibility
                const draw = (Math.min(canvasMag, maxLen) + Math.max(0, maxLen * 0.15 - canvasMag)) / (canvasMag + 1e-9);
                const ax = ux * draw;
                const ay = uy * draw;

                const cx = (gx + 0.5) * sx;
                const cy = (gy + 0.5) * sy;
                const ex = cx + ax;
                const ey = cy + ay;

                const alpha = Math.min(0.92, 0.18 + 0.82 * Math.min(1, mag / 3.5));
                ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;

                const angle = Math.atan2(ay, ax);
                const hLen  = Math.max(2.0, Math.sqrt(ax * ax + ay * ay) * 0.36);

                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(ex, ey);
                ctx.lineTo(ex - hLen * Math.cos(angle - 0.42), ey - hLen * Math.sin(angle - 0.42));
                ctx.moveTo(ex, ey);
                ctx.lineTo(ex - hLen * Math.cos(angle + 0.42), ey - hLen * Math.sin(angle + 0.42));
                ctx.stroke();
            }
        }
    }

    _renderSources(sim) {
        const ctx = this.ctx;
        const sx  = this.canvas.width  / sim.width;
        const sy  = this.canvas.height / sim.height;
        const r0  = Math.min(sx, sy);

        for (const src of sim.sources) {
            const cx = (src.x + 0.5) * sx;
            const cy = (src.y + 0.5) * sy;
            const r  = (src.radius + 2.5) * r0;
            const hot = src.temperature > 0;

            // Outer ring
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = hot ? 'rgba(255,150,0,0.80)' : 'rgba(0,150,255,0.80)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Inner dot
            ctx.beginPath();
            ctx.arc(cx, cy, 2.8, 0, Math.PI * 2);
            ctx.fillStyle = hot ? '#ffaa00' : '#00aaff';
            ctx.fill();
        }
    }

    /** Render the colour-temperature scale into a separate <canvas> element. */
    drawColorbar(legendCanvas) {
        if (!legendCanvas) return;
        const ctx = legendCanvas.getContext('2d');
        const W   = legendCanvas.width;
        const H   = legendCanvas.height;
        const lut = this.colorLUT;
        const N   = this.LUT_SIZE;

        for (let i = 0; i < W; i++) {
            const idx = Math.min(N - 1, Math.floor(i / W * N)) * 4;
            ctx.fillStyle = `rgb(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]})`;
            ctx.fillRect(i, 0, 1, H);
        }
    }
}
