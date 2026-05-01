'use strict';

(function () {
    const SIM_W = 200;
    const SIM_H = 150;

    const canvas        = document.getElementById('canvas');
    const colorbarEl    = document.getElementById('colorbar');
    const sourceListEl  = document.getElementById('source-list');
    const sourceCountEl = document.getElementById('source-count');
    const fpsEl         = document.getElementById('fps-display');

    // ── Simulation & renderer ──────────────────────────────────────────────
    const sim      = new HeatSimulation(SIM_W, SIM_H);
    const renderer = new HeatRenderer(canvas, SIM_W, SIM_H);

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
    let currentTool = 'hot';   // 'hot' | 'cold' | 'erase'
    let paused      = false;
    let mouseDown   = false;
    let lastPaintPos = null;   // debounce painting

    // ── Tool buttons ───────────────────────────────────────────────────────
    const toolBtns = {
        hot:   document.getElementById('tool-hot'),
        cold:  document.getElementById('tool-cold'),
        erase: document.getElementById('tool-erase'),
    };

    function setTool(t) {
        currentTool = t;
        for (const [k, b] of Object.entries(toolBtns)) {
            b.classList.toggle('active', k === t);
        }
    }

    for (const [k, b] of Object.entries(toolBtns)) {
        b.addEventListener('click', () => setTool(k));
    }

    // ── Sliders ────────────────────────────────────────────────────────────
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

    bindSlider('sl-alpha',   'val-alpha',   sim, 'alpha',   v => v.toFixed(2));
    bindSlider('sl-gravity', 'val-gravity', sim, 'gravity', v => v.toFixed(2));
    bindSlider('sl-decay',   'val-decay',   sim, 'decay',   v => v.toFixed(3));

    document.getElementById('sl-vec-spacing').addEventListener('input', function () {
        renderer.vectorSpacing = parseInt(this.value);
        document.getElementById('val-vec-spacing').textContent = this.value;
    });

    document.getElementById('chk-vectors').addEventListener('change', function () {
        renderer.showVectors = this.checked;
    });

    // ── Buttons ────────────────────────────────────────────────────────────
    document.getElementById('btn-clear').addEventListener('click', () => {
        sim.clearField();
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
        sim.reset();
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
        const rect   = canvas.getBoundingClientRect();
        const src    = e.touches ? e.touches[0] : e;
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
            // Debounce: don't add another source if we barely moved
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
        mouseDown   = true;
        lastPaintPos = null;
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

    // Touch support
    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        mouseDown    = true;
        lastPaintPos = null;
        interact(e, true);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (mouseDown) interact(e, true);
    }, { passive: false });
    canvas.addEventListener('touchend', () => { mouseDown = false; });

    // ── Source list ────────────────────────────────────────────────────────
    function updateSourceList() {
        sourceCountEl.textContent = sim.sources.length;
        sourceListEl.innerHTML = '';
        for (const src of sim.sources) {
            const div  = document.createElement('div');
            div.className = 'source-item';

            const dot  = document.createElement('span');
            dot.className = 'source-dot';
            dot.style.background = src.temperature > 0 ? '#ff9900' : '#0099ff';

            const lbl  = document.createElement('span');
            lbl.className = 'source-label';
            lbl.textContent = `${src.temperature > 0 ? 'Hot' : 'Cold'} ${Math.abs(src.temperature).toFixed(2)}`;

            const btn  = document.createElement('button');
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
    const STEPS_PER_FRAME = 3;

    function animate(now) {
        if (!lastTime) lastTime = now;
        const dt = now - lastTime;
        lastTime = now;

        fpsAcc += dt;
        fpsFrames++;
        if (fpsAcc >= 500) {
            fpsEl.textContent = (fpsFrames / (fpsAcc / 1000)).toFixed(1) + ' fps';
            fpsAcc = fpsFrames = 0;
        }

        if (!paused) {
            for (let i = 0; i < STEPS_PER_FRAME; i++) sim.step();
        }
        renderer.render(sim);
        requestAnimationFrame(animate);
    }

    // ── Demo sources ───────────────────────────────────────────────────────
    sim.addSource(Math.floor(SIM_W * 0.28), Math.floor(SIM_H * 0.78), 0.85);
    sim.addSource(Math.floor(SIM_W * 0.72), Math.floor(SIM_H * 0.72), 0.90);
    sim.addSource(Math.floor(SIM_W * 0.50), Math.floor(SIM_H * 0.25), -0.60);
    updateSourceList();

    requestAnimationFrame(animate);
})();
