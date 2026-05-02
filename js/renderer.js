'use strict';

class HeatRenderer {
    constructor(canvas, simWidth, simHeight) {
        this.canvas    = canvas;
        this.ctx       = canvas.getContext('2d');
        this.simWidth  = simWidth;
        this.simHeight = simHeight;

        this.showVectors   = false;
        this.showSources   = false;
        this.vectorSpacing = 12;
        this.vectorScale   = 1.0;

        this.tMin = -1.0;
        this.tMax =  1.0;

        // 4096-entry LUT gives <0.001 precision without visible banding
        this.LUT_SIZE    = 4096;
        this.colormapName = 'heat';
        this.colorLUT    = this._buildColorLUT('heat');

        this.offscreen        = document.createElement('canvas');
        this.offscreen.width  = simWidth;
        this.offscreen.height = simHeight;
        this.offCtx           = this.offscreen.getContext('2d');
        this.offImageData     = this.offCtx.createImageData(simWidth, simHeight);
    }

    // ── Colormaps ─────────────────────────────────────────────────────────────
    // Each entry: [position ∈ [0,1], R, G, B]
    // position 0 → tMin (cold extreme)  0.5 → ambient  1.0 → tMax (hot extreme)

    static COLORMAPS = {
        heat: [
            [0.00,  12,  80, 248],
            [0.10,   5,  60, 210],
            [0.22,   2,  38, 155],
            [0.33,   4,  18,  88],
            [0.42,  14,   8,  52],
            [0.47,  22,   8,  42],
            [0.50,  28,  10,  38],
            [0.53,  36,   8,  28],
            [0.58,  55,   6,  16],
            [0.65, 130,  12,   4],
            [0.73, 218,  38,   0],
            [0.81, 255,  98,   0],
            [0.88, 255, 205,   5],
            [0.94, 255, 248, 145],
            [1.00, 255, 255, 255],
        ],
        bluered: [
            [0.00,   0,  30, 200],
            [0.15,  20,  80, 230],
            [0.30, 100, 165, 255],
            [0.44, 195, 225, 255],
            [0.50, 240, 240, 240],
            [0.56, 255, 210, 190],
            [0.70, 255, 120,  70],
            [0.85, 225,  40,  20],
            [1.00, 165,   0,   0],
        ],
        coolwarm: [
            [0.00,  59,  76, 192],
            [0.20, 100, 138, 235],
            [0.40, 172, 200, 245],
            [0.50, 220, 220, 220],
            [0.60, 245, 185, 155],
            [0.80, 230, 100,  65],
            [1.00, 180,   4,  38],
        ],
        blackbody: [
            [0.00,  12,  15, 140],
            [0.18,   5,   5,  65],
            [0.35,   8,   5,  22],
            [0.50,  18,  10,  22],
            [0.58,  90,   5,   5],
            [0.68, 200,  30,   0],
            [0.78, 255, 105,   0],
            [0.88, 255, 215,  10],
            [1.00, 255, 255, 220],
        ],
        viridis: [
            [0.00,  68,   1,  84],
            [0.13,  71,  44, 122],
            [0.25,  59,  81, 139],
            [0.38,  44, 114, 142],
            [0.50,  33, 145, 140],
            [0.63,  53, 183, 121],
            [0.75,  94, 201,  98],
            [0.88, 174, 220,  50],
            [1.00, 253, 231,  37],
        ],
        inferno: [
            [0.00,   0,   0,   4],
            [0.13,  26,  11,  62],
            [0.25,  87,  16, 110],
            [0.38, 157,  23,  86],
            [0.50, 210,  51,  58],
            [0.63, 243, 107,  36],
            [0.75, 252, 167,  10],
            [0.88, 252, 225,  80],
            [1.00, 252, 255, 164],
        ],
        plasma: [
            [0.00,  13,   8, 135],
            [0.13,  75,   3, 161],
            [0.25, 126,   3, 168],
            [0.38, 168,  34, 150],
            [0.50, 203,  70, 121],
            [0.63, 228, 107,  93],
            [0.75, 248, 149,  64],
            [0.88, 253, 195,  40],
            [1.00, 240, 249,  33],
        ],
    };

    setColormap(name) {
        if (!HeatRenderer.COLORMAPS[name]) return;
        this.colormapName = name;
        this.colorLUT     = this._buildColorLUT(name);
    }

    // ── LUT builder ────────────────────────────────────────────────────────────

    _buildColorLUT(colormapName) {
        const keys = HeatRenderer.COLORMAPS[colormapName] || HeatRenderer.COLORMAPS.heat;
        const N    = this.LUT_SIZE;
        const lut  = new Uint8Array(N * 4);
        const K    = keys.length;

        function cr(t, p0, p1, p2, p3) {
            const t2 = t * t, t3 = t2 * t;
            return 0.5 * (
                  2 * p1
                + (-p0 + p2)                  * t
                + (2*p0 - 5*p1 + 4*p2 - p3)   * t2
                + (-p0 + 3*p1 - 3*p2 + p3)    * t3
            );
        }

        for (let i = 0; i < N; i++) {
            const f = i / (N - 1);
            let seg = K - 2;
            for (let j = 0; j < K - 1; j++) {
                if (f <= keys[j + 1][0]) { seg = j; break; }
            }
            const k0 = keys[Math.max(0,     seg - 1)];
            const k1 = keys[seg];
            const k2 = keys[seg + 1];
            const k3 = keys[Math.min(K - 1, seg + 2)];
            const span = k2[0] - k1[0];
            const t    = span > 0 ? (f - k1[0]) / span : 0;

            lut[i*4]   = Math.max(0, Math.min(255, Math.round(cr(t, k0[1], k1[1], k2[1], k3[1]))));
            lut[i*4+1] = Math.max(0, Math.min(255, Math.round(cr(t, k0[2], k1[2], k2[2], k3[2]))));
            lut[i*4+2] = Math.max(0, Math.min(255, Math.round(cr(t, k0[3], k1[3], k2[3], k3[3]))));
            lut[i*4+3] = 255;
        }
        return lut;
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    render(sim) {
        this._renderField(sim);
        if (this.showVectors) this._renderVectors(sim);
        if (this.showSources) this._renderSources(sim);
    }

    _renderField(sim) {
        const { width: W, height: H, T } = sim;
        const data   = this.offImageData.data;
        const lut    = this.colorLUT;
        const maxIdx = this.LUT_SIZE - 1;
        const scale  = maxIdx / (this.tMax - this.tMin);
        const offset = -this.tMin * scale;

        for (let i = 0; i < W * H; i++) {
            const fi  = T[i] * scale + offset;
            const fic = fi < 0 ? 0 : fi > maxIdx ? maxIdx : fi;
            const i0  = fic | 0;
            const i1  = i0 < maxIdx ? i0 + 1 : i0;
            const tf  = fic - i0;
            const j0  = i0 * 4;
            const j1  = i1 * 4;
            const p   = i * 4;
            data[p]   = (lut[j0]   + tf * (lut[j1]   - lut[j0])  ) | 0;
            data[p+1] = (lut[j0+1] + tf * (lut[j1+1] - lut[j0+1])) | 0;
            data[p+2] = (lut[j0+2] + tf * (lut[j1+2] - lut[j0+2])) | 0;
            data[p+3] = 255;
        }

        this.offCtx.putImageData(this.offImageData, 0, 0);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
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

                const ux = u * sx, uy = v * sy;
                const canvasMag = Math.sqrt(ux*ux + uy*uy);
                const draw = (Math.min(canvasMag, maxLen) +
                               Math.max(0, maxLen * 0.15 - canvasMag)) / (canvasMag + 1e-9);
                const ax = ux * draw, ay = uy * draw;
                const cx = (gx + 0.5) * sx, cy = (gy + 0.5) * sy;
                const ex = cx + ax, ey = cy + ay;
                const alpha = Math.min(0.92, 0.18 + 0.82 * Math.min(1, mag / 3.5));
                ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
                const angle = Math.atan2(ay, ax);
                const hLen  = Math.max(2.0, Math.sqrt(ax*ax + ay*ay) * 0.36);

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
            const cx  = (src.x + 0.5) * sx;
            const cy  = (src.y + 0.5) * sy;
            const r   = (src.radius + 2.5) * r0;
            const hot = src.temperature > 0;

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = hot ? 'rgba(255,150,0,0.80)' : 'rgba(0,150,255,0.80)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, 2.8, 0, Math.PI * 2);
            ctx.fillStyle = hot ? '#ffaa00' : '#00aaff';
            ctx.fill();
        }
    }

    drawColorbar(legendCanvas) {
        if (!legendCanvas) return;
        const ctx    = legendCanvas.getContext('2d');
        const W      = legendCanvas.width;
        const H      = legendCanvas.height;
        const lut    = this.colorLUT;
        const maxIdx = this.LUT_SIZE - 1;

        for (let i = 0; i < W; i++) {
            const fi = (i / (W - 1)) * maxIdx;
            const i0 = fi | 0;
            const i1 = i0 < maxIdx ? i0 + 1 : i0;
            const tf = fi - i0;
            const j0 = i0 * 4, j1 = i1 * 4;
            const r  = (lut[j0]   + tf * (lut[j1]   - lut[j0])  ) | 0;
            const g  = (lut[j0+1] + tf * (lut[j1+1] - lut[j0+1])) | 0;
            const b  = (lut[j0+2] + tf * (lut[j1+2] - lut[j0+2])) | 0;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(i, 0, 1, H);
        }
    }
}
