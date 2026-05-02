'use strict';

(function () {
    const SIM_W = 200;
    const SIM_H = 150;

    const canvas        = document.getElementById('canvas');
    const colorbarEl    = document.getElementById('colorbar');
    const sourceListEl  = document.getElementById('source-list');
    const sourceCountEl = document.getElementById('source-count');
    const fpsEl         = document.getElementById('fps-display');
    const charTogglesEl = document.getElementById('char-toggles');

    // ── Simulation, renderer & text source ────────────────────────────────
    const sim        = new HeatSimulation(SIM_W, SIM_H);
    const renderer   = new HeatRenderer(canvas, SIM_W, SIM_H);
    const textSource = new TextSource(SIM_W, SIM_H);

    // ── Canvas sizing ──────────────────────────────────────────────────────
    function resizeCanvas() {
        const container = document.getElementById('canvas-container');
        const maxW = container.clientWidth  - 16;
        const maxH = container.clientHeight - 16;
        const aspect = SIM_W / SIM_H;
        let w = maxW, h = maxW / aspect;
        if (h > maxH) { h = maxH; w = maxH * aspect; }
        canvas.width  = Math.round(w);
        canvas.height = Math.round(h);
        colorbarEl.width = document.getElementById('colorbar-wrap').clientWidth;
        renderer.drawColorbar(colorbarEl);
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // ── App state ──────────────────────────────────────────────────────────
    let currentTool  = 'hot';
    let paused       = false;
    let mouseDown    = false;
    let lastPaintPos = null;

    // ── Tool buttons ───────────────────────────────────────────────────────
    const toolBtns = {
        hot:   document.getElementById('tool-hot'),
        cold:  document.getElementById('tool-cold'),
        erase: document.getElementById('tool-erase'),
    };

    function setTool(t) {
        currentTool = t;
        for (const [k, b] of Object.entries(toolBtns))
            b.classList.toggle('active', k === t);
    }
    for (const [k, b] of Object.entries(toolBtns))
        b.addEventListener('click', () => setTool(k));

    // ── Generic slider binder ──────────────────────────────────────────────
    function bindSlider(id, valId, obj, prop, fmt) {
        const el    = document.getElementById(id);
        const valEl = document.getElementById(valId);
        function update() {
            const v = parseFloat(el.value);
            obj[prop] = v;
            valEl.textContent = fmt ? fmt(v) : v.toString();
        }
        el.addEventListener('input', update);
        update();
    }

    // ── Physics sliders ────────────────────────────────────────────────────
    bindSlider('sl-alpha',    'val-alpha',    sim, 'alpha',      v => v.toFixed(2));
    bindSlider('sl-gravity',  'val-gravity',  sim, 'gravity',    v => v.toFixed(2));
    bindSlider('sl-decay',    'val-decay',    sim, 'decay',      v => v.toFixed(3));
    bindSlider('sl-vortconf', 'val-vortconf', sim, 'vortConf',   v => v.toFixed(2));
    bindSlider('sl-turb',     'val-turb',     sim, 'turbulence', v => v.toFixed(2));

    document.getElementById('sl-src-temp').addEventListener('input', function () {
        document.getElementById('val-src-temp').textContent = parseFloat(this.value).toFixed(2);
    });

    // ── Text source strength ───────────────────────────────────────────────
    document.getElementById('sl-text-strength').addEventListener('input', function () {
        textSource.strength = parseFloat(this.value);
        document.getElementById('val-text-strength').textContent = textSource.strength.toFixed(2);
    });

    document.getElementById('chk-text-enabled').addEventListener('change', function () {
        textSource.enabled = this.checked;
    });

    // ── Text input & per-character toggle UI ──────────────────────────────
    function buildCharToggles() {
        charTogglesEl.innerHTML = '';
        for (let i = 0; i < textSource.chars.length; i++) {
            const { char, hot } = textSource.chars[i];
            // Skip pure whitespace – it has no visible pixels
            if (char.trim() === '') continue;

            const btn = document.createElement('button');
            btn.className = 'char-btn ' + (hot ? 'hot' : 'cold');
            btn.textContent = char;
            btn.title = (hot ? 'Hot' : 'Cold') + ' — click to toggle';
            const idx = i;
            btn.addEventListener('click', () => {
                textSource.toggleChar(idx);
                btn.className = 'char-btn ' + (textSource.chars[idx].hot ? 'hot' : 'cold');
                btn.title = (textSource.chars[idx].hot ? 'Hot' : 'Cold') + ' — click to toggle';
            });
            charTogglesEl.appendChild(btn);
        }
    }

    function applyText() {
        const raw = document.getElementById('text-input').value;
        textSource.setText(raw);
        buildCharToggles();
    }

    document.getElementById('btn-apply-text').addEventListener('click', applyText);
    document.getElementById('text-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') applyText();
    });

    // ── Visualisation controls ─────────────────────────────────────────────
    document.getElementById('chk-vectors').addEventListener('change', function () {
        renderer.showVectors = this.checked;
    });
    document.getElementById('chk-sources').addEventListener('change', function () {
        renderer.showSources = this.checked;
    });
    document.getElementById('sl-vec-spacing').addEventListener('input', function () {
        renderer.vectorSpacing = parseInt(this.value);
        document.getElementById('val-vec-spacing').textContent = this.value;
    });
    document.getElementById('sl-vec-scale').addEventListener('input', function () {
        renderer.vectorScale = parseFloat(this.value);
        document.getElementById('val-vec-scale').textContent = parseFloat(this.value).toFixed(1);
    });

    // ── Colormap selector ──────────────────────────────────────────────────
    document.getElementById('colormap-select').addEventListener('change', function () {
        renderer.setColormap(this.value);
        colorbarEl.width = document.getElementById('colorbar-wrap').clientWidth;
        renderer.drawColorbar(colorbarEl);
    });

    // ── Action buttons ─────────────────────────────────────────────────────
    document.getElementById('btn-clear').addEventListener('click', () => {
        sim.clearField();
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
        sim.reset();
        document.getElementById('text-input').value = '';
        textSource.setText('');
        buildCharToggles();
        updateSourceList();
    });

    const pauseBtn = document.getElementById('btn-pause');
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        pauseBtn.classList.toggle('active', paused);
    });

    // ── Canvas → simulation coordinates ───────────────────────────────────
    function toSim(e) {
        const rect = canvas.getBoundingClientRect();
        const src  = e.touches ? e.touches[0] : e;
        return {
            x: Math.floor((src.clientX - rect.left) / rect.width  * SIM_W),
            y: Math.floor((src.clientY - rect.top)  / rect.height * SIM_H),
        };
    }

    function getSourceTemp() {
        const strength = parseFloat(document.getElementById('sl-src-temp').value);
        return currentTool === 'hot' ? strength : -strength;
    }

    function interact(e, forceAdd) {
        const pos = toSim(e);
        if (pos.x < 0 || pos.x >= SIM_W || pos.y < 0 || pos.y >= SIM_H) return;

        if (currentTool === 'erase') {
            if (sim.removeNearestSource(pos.x, pos.y)) updateSourceList();
            return;
        }
        if (forceAdd) {
            if (lastPaintPos &&
                Math.hypot(pos.x - lastPaintPos.x, pos.y - lastPaintPos.y) < 5) return;
            lastPaintPos = pos;
            sim.addSource(pos.x, pos.y, getSourceTemp());
            updateSourceList();
        }
    }

    canvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        mouseDown = true; lastPaintPos = null;
        interact(e, true);
    });
    canvas.addEventListener('mousemove', e => {
        if (!mouseDown) return;
        e.preventDefault();
        interact(e, true);
    });
    canvas.addEventListener('mouseup',    () => { mouseDown = false; });
    canvas.addEventListener('mouseleave', () => { mouseDown = false; });
    canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        const pos = toSim(e);
        if (sim.removeNearestSource(pos.x, pos.y)) updateSourceList();
    });
    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        mouseDown = true; lastPaintPos = null;
        interact(e, true);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (mouseDown) interact(e, true);
    }, { passive: false });
    canvas.addEventListener('touchend', () => { mouseDown = false; });

    // ── Source list UI ─────────────────────────────────────────────────────
    function updateSourceList() {
        sourceCountEl.textContent = sim.sources.length;
        sourceListEl.innerHTML = '';
        for (const src of sim.sources) {
            const div = document.createElement('div');
            div.className = 'source-item';

            const dot = document.createElement('span');
            dot.className = 'source-dot';
            dot.style.background = src.temperature > 0 ? '#ff9900' : '#0099ff';

            const lbl = document.createElement('span');
            lbl.className = 'source-label';
            lbl.textContent = `${src.temperature > 0 ? 'Hot' : 'Cold'} ${Math.abs(src.temperature).toFixed(2)}`;

            const btn = document.createElement('button');
            btn.className = 'src-remove';
            btn.textContent = '×';
            btn.addEventListener('click', () => {
                sim.sources = sim.sources.filter(s => s.id !== src.id);
                updateSourceList();
            });

            div.append(dot, lbl, btn);
            sourceListEl.appendChild(div);
        }
    }

    // ── Animation loop ─────────────────────────────────────────────────────
    let lastTime  = 0;
    let fpsFrames = 0;
    let fpsAcc    = 0;
    const STEPS_PER_FRAME = 2;

    function animate(now) {
        if (!lastTime) lastTime = now;
        const elapsed = now - lastTime;
        lastTime = now;

        fpsAcc += elapsed; fpsFrames++;
        if (fpsAcc >= 500) {
            fpsEl.textContent = (fpsFrames / (fpsAcc / 1000)).toFixed(1) + ' fps';
            fpsAcc = fpsFrames = 0;
        }

        if (!paused) {
            for (let i = 0; i < STEPS_PER_FRAME; i++) {
                sim.step();
                textSource.apply(sim.T);  // pin text cells after each physics step
            }
        }
        renderer.render(sim);
        requestAnimationFrame(animate);
    }

    // ── Demo: pre-load "HEAT" text ─────────────────────────────────────────
    const demoText = 'HEAT';
    document.getElementById('text-input').value = demoText;
    textSource.setText(demoText);
    // H and T → hot, E and A → cold (creates a hot/cold mixing pattern by default)
    textSource.toggleChar(1); // E: hot → cold
    textSource.toggleChar(2); // A: hot → cold
    buildCharToggles();

    updateSourceList();
    requestAnimationFrame(animate);
})();
