'use strict';

class HeatRenderer {
    constructor(canvas, simWidth, simHeight) {
        this.canvas    = canvas;
        this.ctx       = canvas.getContext('2d');
        this.simWidth  = simWidth;
        this.simHeight = simHeight;

        this.showVectors   = true;
        this.vectorSpacing = 12;

        // Temperature display range
        this.tMin = -1.0;
        this.tMax =  1.0;

        // Pre-built colour lookup table (LUT) for fast pixel colouring
        this.LUT_SIZE = 1024;
        this.colorLUT = this._buildColorLUT();

        // Off-screen canvas for pixel-level temperature rendering
        this.offscreen          = document.createElement('canvas');
        this.offscreen.width    = simWidth;
        this.offscreen.height   = simHeight;
        this.offCtx             = this.offscreen.getContext('2d');
        this.offImageData       = this.offCtx.createImageData(simWidth, simHeight);
    }

    // Diverging colormap: cold blue → black → purple → red → orange → white
    _buildColorLUT() {
        const N = this.LUT_SIZE;
        const lut = new Uint8Array(N * 4);

        // [normalised_position, r, g, b]  where pos ∈ [0,1] maps tMin→tMax
        const keys = [
            [0.00,  30, 110, 255],  // T = tMin  – cold blue
            [0.20,   0,  30, 180],  // T = -0.6  – medium blue
            [0.42,   0,   0,  18],  // T = -0.16 – near-black
            [0.50,   0,   0,   5],  // T = 0     – ambient (near-black)
            [0.58,  50,   0,  45],  // T = +0.16 – dark purple
            [0.68, 180,   0,  15],  // T = +0.36 – dark crimson
            [0.78, 255,  80,   0],  // T = +0.56 – orange
            [0.88, 255, 215,   0],  // T = +0.76 – yellow
            [0.94, 255, 255, 160],  // T = +0.88 – pale yellow
            [1.00, 255, 255, 255],  // T = tMax  – white
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
        this._renderSources(sim);
    }

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
        const { width: W, height: H, vx, vy, gravity } = sim;
        const ctx = this.ctx;
        const cW  = this.canvas.width;
        const cH  = this.canvas.height;
        const sx  = cW / W;
        const sy  = cH / H;
        const sp  = this.vectorSpacing;

        ctx.lineWidth = 1;

        for (let gy = (sp / 2) | 0; gy < H; gy += sp) {
            for (let gx = (sp / 2) | 0; gx < W; gx += sp) {
                const i   = gy * W + gx;
                const u   = vx[i];
                const v   = vy[i];
                const mag = Math.sqrt(u * u + v * v);
                if (mag < 0.02) continue;

                // Scale so maximum arrow = 0.6 * spacing pixels
                const maxPx  = sp * 0.6;
                const scale  = Math.min(maxPx / (mag * Math.min(sx, sy)), maxPx);
                const ax     = u * scale * sx / Math.min(sx, sy);
                const ay     = v * scale * sy / Math.min(sx, sy);

                const cx = (gx + 0.5) * sx;
                const cy = (gy + 0.5) * sy;
                const ex = cx + ax;
                const ey = cy + ay;

                const alpha = Math.min(0.9, 0.25 + 0.75 * Math.min(1, mag / (gravity + 0.01)));
                ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;

                const angle = Math.atan2(ay, ax);
                const hLen  = Math.max(2.5, Math.sqrt(ax * ax + ay * ay) * 0.35);

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
            const r  = (src.radius + 2) * r0;

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = src.temperature > 0
                ? 'rgba(255, 160, 0, 0.75)'
                : 'rgba(0, 160, 255, 0.75)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = src.temperature > 0 ? '#ffaa00' : '#00aaff';
            ctx.fill();
        }
    }

    // Draw the colormap scale into a separate <canvas> element.
    drawColorbar(legendCanvas) {
        if (!legendCanvas) return;
        const ctx = legendCanvas.getContext('2d');
        const W   = legendCanvas.width;
        const H   = legendCanvas.height;
        const lut = this.colorLUT;
        const N   = this.LUT_SIZE;

        for (let i = 0; i < W; i++) {
            const idx = Math.min(N - 1, Math.floor(i / W * N)) * 4;
            ctx.fillStyle = `rgb(${lut[idx]},${lut[idx+1]},${lut[idx+2]})`;
            ctx.fillRect(i, 0, 1, H);
        }
    }
}
