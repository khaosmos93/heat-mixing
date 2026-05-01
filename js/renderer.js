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

        // Pre-built colour lookup table for fast pixel colouring.
        // 4096 entries give <0.001 temperature-unit precision before fractional
        // interpolation, eliminating all visible quantisation steps.
        this.LUT_SIZE = 4096;
        this.colorLUT = this._buildColorLUT();

        // Off-screen canvas for pixel-level temperature rendering
        this.offscreen       = document.createElement('canvas');
        this.offscreen.width  = simWidth;
        this.offscreen.height = simHeight;
        this.offCtx          = this.offscreen.getContext('2d');
        this.offImageData    = this.offCtx.createImageData(simWidth, simHeight);
    }

    /**
     * Diverging colourmap built with Catmull-Rom spline interpolation.
     *
     * Catmull-Rom gives C1-continuous transitions — no slope kinks at keypoint
     * boundaries, so colour gradients are smooth everywhere.
     *
     * Keypoint design goals:
     *   • Cold side (T < 0): vivid cyan-blue fading to a cool dark indigo near ambient.
     *   • Ambient (T ≈ 0): a dim but non-black indigo — ensures tiny temperature
     *     deviations from ambient are still chromatic and mixing is always perceptible.
     *   • Hot side (T > 0): dark crimson rising through orange to yellow-white.
     *   • Symmetric perceptual brightness curve so cold/hot mixing reads as gradual.
     */
    _buildColorLUT() {
        const N    = this.LUT_SIZE;
        const lut  = new Uint8Array(N * 4);

        // [normalised position ∈ [0,1], R, G, B]
        // position 0 → tMin (cold), 0.5 → 0 (ambient), 1.0 → tMax (hot)
        const keys = [
            [0.00,  12,  80, 248],  // T=−1.00  vivid blue
            [0.10,   5,  60, 210],  // T=−0.80
            [0.22,   2,  38, 155],  // T=−0.56
            [0.33,   4,  18,  88],  // T=−0.34
            [0.42,  14,   8,  52],  // T=−0.16  dim violet-blue
            [0.47,  22,   8,  42],  // T=−0.06  (dense near-zero coverage)
            [0.50,  28,  10,  38],  // T= 0.00  dark indigo — NOT pure black,
            [0.53,  36,   8,  28],  //           so mixing is always visible
            [0.58,  55,   6,  16],  // T=+0.16
            [0.65, 130,  12,   4],  // T=+0.30
            [0.73, 218,  38,   0],  // T=+0.46  red
            [0.81, 255,  98,   0],  // T=+0.62  orange
            [0.88, 255, 205,   5],  // T=+0.76  yellow
            [0.94, 255, 248, 145],  // T=+0.88  pale yellow
            [1.00, 255, 255, 255],  // T=+1.00  white
        ];
        const K = keys.length;

        // Catmull-Rom: C1-continuous spline through the keypoints.
        // Uses clamped phantom points at the two ends.
        function cr(t, p0, p1, p2, p3) {
            const t2 = t * t, t3 = t2 * t;
            return 0.5 * (
                  2 * p1
                + (-p0 + p2)             * t
                + (2*p0 - 5*p1 + 4*p2 - p3) * t2
                + (-p0 + 3*p1 - 3*p2 + p3)  * t3
            );
        }

        for (let i = 0; i < N; i++) {
            const f = i / (N - 1);

            // Find the segment [seg, seg+1] that f falls in
            let seg = K - 2;
            for (let j = 0; j < K - 1; j++) {
                if (f <= keys[j + 1][0]) { seg = j; break; }
            }

            // Clamped neighbours for first/last segments
            const k0 = keys[Math.max(0,     seg - 1)];
            const k1 = keys[seg];
            const k2 = keys[seg + 1];
            const k3 = keys[Math.min(K - 1, seg + 2)];

            const span = k2[0] - k1[0];
            const t    = span > 0 ? (f - k1[0]) / span : 0;

            lut[i * 4]     = Math.max(0, Math.min(255, Math.round(cr(t, k0[1], k1[1], k2[1], k3[1]))));
            lut[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(cr(t, k0[2], k1[2], k2[2], k3[2]))));
            lut[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(cr(t, k0[3], k1[3], k2[3], k3[3]))));
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
        const data    = this.offImageData.data;
        const lut     = this.colorLUT;
        const maxIdx  = this.LUT_SIZE - 1;   // last valid LUT index
        // Pre-compute linear mapping: temperature → floating-point LUT index
        const scale   = maxIdx / (this.tMax - this.tMin);
        const offset  = -this.tMin * scale;

        for (let i = 0; i < W * H; i++) {
            // Continuous (fractional) LUT index — eliminates integer quantisation bands.
            const fi = T[i] * scale + offset;
            // Clamp to [0, maxIdx] then split into integer + fractional parts.
            const fic = fi < 0 ? 0 : fi > maxIdx ? maxIdx : fi;
            const i0  = fic | 0;                        // floor index
            const i1  = i0 < maxIdx ? i0 + 1 : i0;     // ceil index (clamped)
            const tf  = fic - i0;                       // blend factor ∈ [0, 1)
            const j0  = i0 * 4;
            const j1  = i1 * 4;

            // Linear interpolation between adjacent LUT entries — perfectly smooth.
            const p = i * 4;
            data[p]     = (lut[j0]     + tf * (lut[j1]     - lut[j0])    ) | 0;
            data[p + 1] = (lut[j0 + 1] + tf * (lut[j1 + 1] - lut[j0 + 1])) | 0;
            data[p + 2] = (lut[j0 + 2] + tf * (lut[j1 + 2] - lut[j0 + 2])) | 0;
            data[p + 3] = 255;
        }

        this.offCtx.putImageData(this.offImageData, 0, 0);

        // High-quality bilinear upscale from sim resolution → display resolution.
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
        const ctx    = legendCanvas.getContext('2d');
        const W      = legendCanvas.width;
        const H      = legendCanvas.height;
        const lut    = this.colorLUT;
        const maxIdx = this.LUT_SIZE - 1;

        for (let i = 0; i < W; i++) {
            // Fractional LUT lookup so the legend also shows a perfectly smooth gradient
            const fi = (i / (W - 1)) * maxIdx;
            const i0 = fi | 0;
            const i1 = i0 < maxIdx ? i0 + 1 : i0;
            const tf = fi - i0;
            const j0 = i0 * 4, j1 = i1 * 4;
            const r  = (lut[j0]     + tf * (lut[j1]     - lut[j0])    ) | 0;
            const g  = (lut[j0 + 1] + tf * (lut[j1 + 1] - lut[j0 + 1])) | 0;
            const b  = (lut[j0 + 2] + tf * (lut[j1 + 2] - lut[j0 + 2])) | 0;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(i, 0, 1, H);
        }
    }
}
