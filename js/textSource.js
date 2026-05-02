'use strict';

/**
 * TextSource — converts typed text (with optional LaTeX-symbol preprocessing)
 * into per-character pixel masks at simulation resolution.  Each character can
 * independently be assigned hot (+1) or cold (−1).
 */
class TextSource {
    constructor(simWidth, simHeight) {
        this.simWidth  = simWidth;
        this.simHeight = simHeight;

        // Render text at 4× resolution for clean antialiased shapes
        this._S  = 4;
        this._tc = document.createElement('canvas');
        this._tc.width  = simWidth  * this._S;
        this._tc.height = simHeight * this._S;
        this._tx = this._tc.getContext('2d', { willReadFrequently: true });

        this.chars    = [];  // [{ char:string, hot:bool }]
        this.masks    = [];  // Float32Array per char, at sim resolution
        this.text     = '';
        this.enabled  = true;
        this.strength = 0.65;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * (Re)set displayed text.  Previous hot/cold assignments are preserved
     * positionally so editing doesn't lose user state.
     */
    setText(rawText) {
        const display = TextSource.latexToUnicode(rawText);
        const prevHot = this.chars.map(c => c.hot);

        this.text  = display;
        this.chars = [];
        this.masks = [];

        for (let i = 0; i < display.length; i++) {
            this.chars.push({ char: display[i], hot: prevHot[i] !== undefined ? prevHot[i] : true });
        }
        this._rebuild();
        return this.chars;
    }

    toggleChar(index) {
        if (index >= 0 && index < this.chars.length) {
            this.chars[index].hot = !this.chars[index].hot;
            this._rebuild();
        }
    }

    /** Pin text-covered cells to their target temperature each simulation step. */
    apply(T) {
        if (!this.enabled || !this.chars.length) return;
        const W = this.simWidth, H = this.simHeight;
        const n = W * H;

        for (let ci = 0; ci < this.chars.length; ci++) {
            const m      = this.masks[ci];
            const target = this.chars[ci].hot ? 1.0 : -1.0;
            const k      = this.strength;
            for (let i = 0; i < n; i++) {
                const w = m[i];
                if (w > 0.04) T[i] += k * w * (target - T[i]);
            }
        }
    }

    // ── LaTeX → Unicode preprocessing ────────────────────────────────────────

    static latexToUnicode(src) {
        const MAP = {
            '\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ',
            '\\epsilon':'ε','\\varepsilon':'ε','\\zeta':'ζ','\\eta':'η',
            '\\theta':'θ','\\vartheta':'ϑ','\\iota':'ι','\\kappa':'κ',
            '\\lambda':'λ','\\mu':'μ','\\nu':'ν','\\xi':'ξ',
            '\\pi':'π','\\varpi':'ϖ','\\rho':'ρ','\\varrho':'ϱ',
            '\\sigma':'σ','\\varsigma':'ς','\\tau':'τ','\\upsilon':'υ',
            '\\phi':'φ','\\varphi':'φ','\\chi':'χ','\\psi':'ψ','\\omega':'ω',
            '\\Gamma':'Γ','\\Delta':'Δ','\\Theta':'Θ','\\Lambda':'Λ',
            '\\Xi':'Ξ','\\Pi':'Π','\\Sigma':'Σ','\\Upsilon':'Υ',
            '\\Phi':'Φ','\\Psi':'Ψ','\\Omega':'Ω',
            '\\sum':'∑','\\prod':'∏','\\coprod':'∐',
            '\\int':'∫','\\iint':'∬','\\iiint':'∭','\\oint':'∮',
            '\\partial':'∂','\\nabla':'∇','\\infty':'∞',
            '\\hbar':'ℏ','\\ell':'ℓ','\\wp':'℘','\\Re':'ℜ','\\Im':'ℑ',
            '\\aleph':'ℵ','\\beth':'ℶ',
            '\\pm':'±','\\mp':'∓','\\times':'×','\\div':'÷',
            '\\cdot':'·','\\cdots':'⋯','\\ldots':'…','\\vdots':'⋮','\\ddots':'⋱',
            '\\leq':'≤','\\geq':'≥','\\ll':'≪','\\gg':'≫',
            '\\neq':'≠','\\approx':'≈','\\sim':'∼','\\simeq':'≃',
            '\\equiv':'≡','\\cong':'≅','\\propto':'∝',
            '\\in':'∈','\\notin':'∉','\\ni':'∋',
            '\\subset':'⊂','\\supset':'⊃','\\subseteq':'⊆','\\supseteq':'⊇',
            '\\cup':'∪','\\cap':'∩','\\emptyset':'∅','\\varnothing':'∅',
            '\\to':'→','\\leftarrow':'←','\\rightarrow':'→',
            '\\Rightarrow':'⇒','\\Leftarrow':'⇐','\\Leftrightarrow':'⟺',
            '\\leftrightarrow':'↔','\\uparrow':'↑','\\downarrow':'↓',
            '\\nearrow':'↗','\\searrow':'↘','\\swarrow':'↙','\\nwarrow':'↖',
            '\\forall':'∀','\\exists':'∃','\\nexists':'∄',
            '\\land':'∧','\\lor':'∨','\\lnot':'¬','\\neg':'¬',
            '\\oplus':'⊕','\\ominus':'⊖','\\otimes':'⊗','\\oslash':'⊘',
            '\\circ':'∘','\\bullet':'•','\\star':'⋆',
            '\\sqrt':'√','\\prime':'′','\\dagger':'†','\\ddagger':'‡',
            '\\angle':'∠','\\measuredangle':'∡','\\perp':'⊥','\\parallel':'∥',
            '\\triangle':'△','\\square':'□','\\diamond':'◇',
            '\\langle':'⟨','\\rangle':'⟩',
            '\\|':'‖','\\{':'{','\\}':'}',
            '\\,':' ','\\;':' ','\\!':'','\\quad':' ','\\qquad':'  ',
        };

        let s = src.trim();
        // Strip math delimiters
        s = s.replace(/^\$\$|\$\$$/g, '').replace(/^\$|\$$/g, '');
        s = s.replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').trim();

        // Apply longest-first to prevent partial matches (e.g. \alpha vs \al)
        const keys = Object.keys(MAP).sort((a, b) => b.length - a.length);
        for (const k of keys) s = s.split(k).join(MAP[k]);

        // Superscripts: ^{...} or ^x
        const sup = '⁰¹²³⁴⁵⁶⁷⁸⁹';
        s = s.replace(/\^\{([^}]+)\}/g, (_, t) => [...t].map(c => sup[+c] ?? c).join(''));
        s = s.replace(/\^(\d)/g, (_, d) => sup[+d]);

        // Subscripts: _{...} or _x
        const sub = '₀₁₂₃₄₅₆₇₈₉';
        s = s.replace(/_\{([^}]+)\}/g, (_, t) => [...t].map(c => sub[+c] ?? c).join(''));
        s = s.replace(/_(\d)/g, (_, d) => sub[+d]);

        // Remove remaining LaTeX tokens
        s = s.replace(/\\[a-zA-Z]+\*?/g, '').replace(/[{}\[\]]/g, '');
        return s;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _rebuild() {
        const { simWidth: W, simHeight: H, _S: S, _tx: ctx } = this;
        const TW = W * S, TH = H * S;

        ctx.clearRect(0, 0, TW, TH);
        this.masks = [];

        if (!this.text) return;

        // Choose font size; shrink to fit width
        let fontSize = Math.floor(TH * 0.60);
        const FONT   = (sz) => `bold ${sz}px Georgia, "Times New Roman", serif`;
        ctx.font = FONT(fontSize);
        ctx.textBaseline = 'alphabetic';

        let totalW = ctx.measureText(this.text).width;
        const maxW = TW * 0.90;
        if (totalW > maxW) {
            fontSize = Math.floor(fontSize * maxW / totalW);
            ctx.font = FONT(fontSize);
            totalW   = ctx.measureText(this.text).width;
        }

        // Character advance positions
        const startX = (TW - totalW) / 2;
        const baseY  = TH * 0.63;
        let curX = startX;
        const advances = [];
        for (const { char } of this.chars) {
            advances.push(curX);
            curX += ctx.measureText(char).width;
        }

        // Render entire text onto offscreen canvas with per-char colours
        // (hot = opaque red, cold = opaque blue — alpha encodes "is text pixel")
        for (let i = 0; i < this.chars.length; i++) {
            ctx.fillStyle = this.chars[i].hot ? '#ff4400' : '#0044ff';
            ctx.fillText(this.chars[i].char, advances[i], baseY);
        }

        // Read pixels once, then build per-character masks via column slicing
        const imgData = ctx.getImageData(0, 0, TW, TH).data;

        for (let ci = 0; ci < this.chars.length; ci++) {
            const charW  = ctx.measureText(this.chars[ci].char).width;
            // Column range in high-res space (with a 1-cell margin)
            const xLo = Math.max(0,    Math.floor(advances[ci]) - S);
            const xHi = Math.min(TW-1, Math.ceil(advances[ci] + charW) + S);

            const mask = new Float32Array(W * H);

            for (let sy = 0; sy < H; sy++) {
                const ryBase = sy * S;
                for (let sx = 0; sx < W; sx++) {
                    const rxBase = sx * S;
                    // Only sample pixels within this character's column range
                    const colLo = Math.max(rxBase, xLo);
                    const colHi = Math.min(rxBase + S - 1, xHi);
                    if (colHi < colLo) continue;

                    let alpha = 0;
                    let count = 0;
                    for (let dy = 0; dy < S; dy++) {
                        const ry = ryBase + dy;
                        for (let dx = 0; dx < S; dx++) {
                            const rx = rxBase + dx;
                            if (rx < colLo || rx > colHi) continue;
                            const p = (ry * TW + rx) * 4;
                            alpha += imgData[p + 3];
                            count++;
                        }
                    }
                    if (count > 0) mask[sy * W + sx] = alpha / (count * 255);
                }
            }
            this.masks.push(mask);
        }
    }
}
