/* ============================================================
 * VIZINHANÇA 26 — Motor de visualização
 * Lê os dados de um ZIP hospedado em GitHub Releases (via JSZip).
 * ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 1. CONFIGURAÇÃO - 1
  // ============================================================
  const CONFIG = {
    // URL do ZIP no release
    zipURL: 'https://github.com/mroctoz/vizinhanca26-dados/releases/download/dados-v1/dados-v1.zip',

    cargos: {
      presidente: { nome: 'Presidente', arquivoLV: 'presidenteLV' },
      governador: { nome: 'Governador', arquivoLV: 'governadorLV' },
      senador:    { nome: 'Senador',    arquivoLV: 'senadorLV' }
    },

    metricasEspeciais: {
      brancos:        { nome: 'Brancos',        cor: '#9ca3af' },
      nulos:          { nome: 'Nulos',          cor: '#6b7280' },
      abstencoes:     { nome: 'Abstenções',     cor: '#374151' },
      comparecimento: { nome: 'Comparecimento', cor: '#1f2937' }
    },

    ufs: ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
          'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'],

    tiles: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    },

    estiloGeoJSON: { weight: 1, color: '#ffffff', opacity: 0.9, fillOpacity: 0.85 },

    centroInicial: [-15.78, -47.93],
    zoomInicial: 4
  };

  const CORES_PARTIDOS = {
    'PT':'#de0000','PL':'#402386','PSD':'#99ad00','Novo':'#f58220','Missão':'#f6ae08',
    'Avante':'#2ebf98','UP':'#009b3a','PSTU':'#a31b1b','PCB':'#cc0000','PCO':'#8b0000',
    'PRTB':'#003399','Democratas':'#0055a5','DC':'#2a4d9c','Republicanos':'#008f8c',
    'MDB':'#028a00','PDT':'#d100ca','PSOL':'#ffcc00','PSDB':'#002fbd','PSB':'#ff2a00',
    'UNIÃO':'#009eb3','PP':'#3c6baa','PODEMOS':'#2555a2','PODE':'#2555a2','Agir':'#06b6d4',
    'Mobiliza':'#e74c3c','Solidariedade':'#f97316','Rede':'#059669','PRD':'#d97706',
    'Outros':'#8b5cf6'
  };

  // ============================================================
  // 2. ESTADO E CACHE
  // ============================================================
  const state = {
    cargo: 'presidente',
    metrica: null,
    uf: null,
    municipio: null,
    camadaAtual: 'BR',
    mapa: null,
    camadaGeo: null
  };

  const cache = {
    zip: null,
    zipPromise: null,
    malhaBR: null,
    malhaMUN: {},
    malhaLV: {},
    resultadosMUN: {},
    resultadosLV: {},
    resultadosBRagregado: null
  };

  // ============================================================
  // 3. CARREGAMENTO DO ZIP
  // ============================================================
  async function carregarZip() {
    if (cache.zip) return cache.zip;
    if (cache.zipPromise) return cache.zipPromise;

    cache.zipPromise = (async () => {
      const msg = document.getElementById('loader-msg');
      const bar = document.getElementById('loader-bar-fill');

      try {
        if (msg) msg.textContent = 'Baixando base de dados…';
        const resp = await fetch(CONFIG.zipURL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
        const reader = resp.body.getReader();
        const chunks = [];
        let recebido = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          recebido += value.length;
          if (bar && total) {
            const pct = (recebido / total) * 100;
            bar.style.width = pct.toFixed(1) + '%';
          }
          if (msg) {
            const mb = (recebido / 1e6).toFixed(1);
            const mbTot = total ? (total / 1e6).toFixed(1) : '?';
            msg.textContent = `Baixando… ${mb} MB de ${mbTot} MB`;
          }
        }

        if (msg) msg.textContent = 'Extraindo base…';
        if (bar) bar.style.width = '100%';

        const blob = new Blob(chunks);
        const zip = await JSZip.loadAsync(blob);
        cache.zip = zip;

        // Esconde loader
        const loader = document.getElementById('loader');
        if (loader) {
          loader.classList.add('escondido');
          setTimeout(() => loader.style.display = 'none', 400);
        }

        return zip;
      } catch (err) {
        if (msg) msg.textContent = 'Erro: ' + err.message;
        throw err;
      }
    })();

    return cache.zipPromise;
  }

  // Lê um arquivo de dentro do ZIP e devolve como JSON
  async function fetchJSON(caminho) {
    const zip = await carregarZip();
    // Tenta com o caminho exato; se não achar, tenta variações
    let file = zip.file(caminho);
    if (!file) {
      // Tenta com barra inicial, ou dentro de vizinhanca26/
      const candidatos = [
        caminho.replace(/^\//, ''),
        'vizinhanca26/' + caminho,
        'dados-release/' + caminho
      ];
      for (const c of candidatos) {
        file = zip.file(c);
        if (file) break;
      }
    }
    if (!file) {
      throw new Error(`Arquivo não encontrado no ZIP: ${caminho}`);
    }
    const txt = await file.async('text');
    return JSON.parse(txt);
  }

  // Caminhos dentro do ZIP — ajuste aqui se a estrutura interna for diferente
  const path = {
    malhaUF:       () => `malha/UF/BR_UF_2025.json`,
    malhaMUN:      (uf) => `malha/UF/${uf}/${uf}.geojson`,
    malhaLV:       (uf, cdMun) => `malha/UF/MUN/LV/areas_influencia_brasil/${cdMun}.geojson`,
    resultadosMUN: (uf) => `resultados/MUN/${uf}.json`,
    resultadosLV:  (cargo, uf) => `resultados/${CONFIG.cargos[cargo].arquivoLV}/${uf}.json`
  };

  // ============================================================
  // 4. CORES
  // ============================================================
  function hexParaHsl(hex) {
    const h = hex.replace('#','');
    const r = parseInt(h.substr(0,2),16)/255,
          g = parseInt(h.substr(2,2),16)/255,
          b = parseInt(h.substr(4,2),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let hh, ss, ll = (max+min)/2;
    if (max === min) { hh = ss = 0; }
    else {
      const d = max - min;
      ss = ll > 0.5 ? d/(2-max-min) : d/(max+min);
      switch (max) {
        case r: hh = (g-b)/d + (g<b?6:0); break;
        case g: hh = (b-r)/d + 2; break;
        default: hh = (r-g)/d + 4;
      }
      hh /= 6;
    }
    return { h: hh*360, s: ss, l: ll };
  }

  function hslParaHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l*(1+s) : l+s-l*s;
      const p = 2*l - q;
      const hue2rgb = (p,q,t) => {
        if (t<0) t+=1; if (t>1) t-=1;
        if (t<1/6) return p+(q-p)*6*t;
        if (t<1/2) return q;
        if (t<2/3) return p+(q-p)*(2/3-t)*6;
        return p;
      };
      r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
    }
    const toHex = (x) => {
      const v = Math.round(x*255).toString(16);
      return v.length === 1 ? '0'+v : v;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  function corGradiente(pct, corBase) {
    if (!corBase) corBase = '#888888';
    if (pct == null || isNaN(pct)) return '#f3f4f6';
    pct = Math.max(0, Math.min(1, pct));
    const { h, s } = hexParaHsl(corBase);
    const sMin = 0.15, sMax = s;
    const lMin = 0.92, lMax = 0.42;
    return hslParaHex(h, sMin+(sMax-sMin)*pct, lMin+(lMax-lMin)*pct);
  }

  function corSecundaria(corBase) {
    const { h, s, l } = hexParaHsl(corBase);
    return hslParaHex(h-25, Math.min(1, s*1.05), Math.max(0.15, l*0.78));
  }

  // ============================================================
  // 5. UTIL
  // ============================================================
  const fmt = {
    numero: (n) => (n == null ? '—' : n.toLocaleString('pt-BR')),
    percentual: (v) => (v == null ? '—' : (v*100).toFixed(2).replace('.',',') + '%')
  };
  function pct(v, t) { return (!t || t <= 0) ? 0 : v/t; }

  // ============================================================
  // 6. API — leitura dos dados do ZIP
  // ============================================================
  const api = {
    async malhaBR() {
      if (cache.malhaBR) return cache.malhaBR;
      cache.malhaBR = await fetchJSON(path.malhaUF());
      return cache.malhaBR;
    },
    async malhaMUN(uf) {
      if (cache.malhaMUN[uf]) return cache.malhaMUN[uf];
      cache.malhaMUN[uf] = await fetchJSON(path.malhaMUN(uf));
      return cache.malhaMUN[uf];
    },
    async malhaLV(uf, cdMun) {
      if (cache.malhaLV[cdMun]) return cache.malhaLV[cdMun];
      cache.malhaLV[cdMun] = await fetchJSON(path.malhaLV(uf, cdMun));
      return cache.malhaLV[cdMun];
    },
    async resultadosMUN(uf) {
      if (cache.resultadosMUN[uf]) return cache.resultadosMUN[uf];
      cache.resultadosMUN[uf] = await fetchJSON(path.resultadosMUN(uf));
      return cache.resultadosMUN[uf];
    },
    async resultadosLV(cargo, uf) {
      const key = `${cargo}_${uf}`;
      if (cache.resultadosLV[key]) return cache.resultadosLV[key];
      cache.resultadosLV[key] = await fetchJSON(path.resultadosLV(cargo, uf));
      return cache.resultadosLV[key];
    },
    async resultadosBRAgregado() {
      if (cache.resultadosBRagregado) return cache.resultadosBRagregado;
      const agregado = { ufs: {} };
      for (const uf of CONFIG.ufs) {
        try {
          const r = await api.resultadosMUN(uf);
          agregado.ufs[uf] = { uf, cargos: r.cargos || {} };
        } catch (e) {
          console.warn(`Sem dados para ${uf}:`, e.message);
        }
      }
      cache.resultadosBRagregado = agregado;
      return agregado;
    }
  };

  // ============================================================
  // 7. MAPA
  // ============================================================
  const mapa = {
    init(elId) {
      state.mapa = L.map(elId, {
        center: CONFIG.centroInicial,
        zoom: CONFIG.zoomInicial,
        zoomControl: true
      });
      L.tileLayer(CONFIG.tiles.url, {
        attribution: CONFIG.tiles.attribution,
        maxZoom: 19
      }).addTo(state.mapa);
    },
    limpar() {
      if (state.camadaGeo) {
        state.mapa.removeLayer(state.camadaGeo);
        state.camadaGeo = null;
      }
    },
    render(geojson, estiloFn, onEach, onClick) {
      mapa.limpar();
      state.camadaGeo = L.geoJSON(geojson, {
        style: estiloFn,
        onEachFeature: (feature, layer) => {
          if (onEach) onEach(feature, layer);
          if (onClick) layer.on('click', () => onClick(feature));
        }
      }).addTo(state.mapa);
    },
    ajustarBounds() {
      if (state.camadaGeo) {
        try { state.mapa.fitBounds(state.camadaGeo.getBounds(), { padding: [20,20] }); }
        catch(e){}
      }
    }
  };

  // ============================================================
  // 8. LÓGICA DE MÉTRICA
  // ============================================================
  function extrairMetrica(obj, cargoAtual) {
    const m = state.metrica;
    if (!m) return { valor: 0, total: 0, pct: 0 };

    const nomeCargo = CONFIG.cargos[cargoAtual].nome;
    const bloco = (obj.cargos || {})[nomeCargo] || {};

    const comparecimento = bloco.comparecimento || 0;
    const brancos        = bloco.brancos || 0;
    const nulos          = bloco.nulos || 0;
    const votosValidos   = bloco.votos_validos || 0;

    if (m.startsWith('cand_')) {
      const nr = m.substring(5);
      const cand = (bloco.candidatos || []).find(c =>
        String(c.nr_candidato ?? c.nr_votavel) === nr
      );
      const votos = cand ? (cand.qt_votos || 0) : 0;
      return { valor: votos, total: votosValidos, pct: pct(votos, votosValidos) };
    }

    switch (m) {
      case 'brancos':        return { valor: brancos,        total: comparecimento, pct: pct(brancos, comparecimento) };
      case 'nulos':          return { valor: nulos,          total: comparecimento, pct: pct(nulos, comparecimento) };
      case 'abstencoes':     return { valor: 0,              total: comparecimento, pct: 0 };
      case 'comparecimento': return { valor: comparecimento, total: comparecimento, pct: 1 };
    }
    return { valor: 0, total: 0, pct: 0 };
  }

  function corBaseMetrica(listaCands) {
    const m = state.metrica;
    if (!m) return '#888';
    if (m.startsWith('cand_')) {
      const nr = m.substring(5);
      const cand = listaCands.find(c => String(c.nr_candidato ?? c.nr_votavel) === nr);
      if (!cand) return '#888';
      const nome = cand.nm_candidato || cand.nm_votavel || '';
      let cor = CORES_PARTIDOS['Outros'];
      for (const sigla in CORES_PARTIDOS) {
        if (sigla.length >= 3 && nome.toUpperCase().includes(sigla.toUpperCase())) {
          cor = CORES_PARTIDOS[sigla]; break;
        }
      }
      if (state.cargo === 'senador') {
        const anteriores = listaCands.filter(c =>
          c !== cand &&
          (c.nm_candidato || '').toUpperCase().includes(
            (Object.keys(CORES_PARTIDOS).find(s => nome.toUpperCase().includes(s.toUpperCase())) || '').toUpperCase()
          )
        );
        if (anteriores.length > 0) cor = corSecundaria(cor);
      }
      return cor;
    }
    return CONFIG.metricasEspeciais[m]?.cor || '#888';
  }

  // ============================================================
  // 9. RENDERIZAÇÃO
  // ============================================================
  async function renderBR() {
    state.camadaAtual = 'BR';
    ui.setBreadcrumb([{ nome: 'Brasil', nivel: 'BR' }]);

    const [geojson, res] = await Promise.all([api.malhaBR(), api.resultadosBRAgregado()]);

    const valores = [];
    for (const feat of geojson.features) {
      const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
      const r = res.ufs[sigla];
      if (!r) continue;
      valores.push(extrairMetrica({ cargos: r.cargos }, state.cargo));
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    const corBase = corBaseMetrica(ui._candidatos);

    mapa.render(
      geojson,
      (feat) => {
        const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
        const r = res.ufs[sigla];
        let p = 0;
        if (r) p = extrairMetrica({ cargos: r.cargos }, state.cargo).pct;
        return { ...CONFIG.estiloGeoJSON, fillColor: corGradiente(p/maxPct, corBase) };
      },
      (feat, layer) => {
        const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
        const nome = feat.properties.NM_UF || sigla;
        const r = res.ufs[sigla];
        const met = extrairMetrica(r ? { cargos: r.cargos } : { cargos: {} }, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> (${fmt.percentual(met.pct)})`,
          { sticky: true }
        );
      },
      (feat) => irParaUF(feat.properties.SIGLA_UF || feat.properties.CD_UF)
    );
    mapa.ajustarBounds();
    ui.renderLegenda(corBase, maxPct);
  }

  async function renderUF(uf) {
    state.camadaAtual = 'UF';
    ui.setBreadcrumb([{ nome: 'Brasil', nivel: 'BR' }, { nome: uf, nivel: 'UF' }]);

    const [geojson, res] = await Promise.all([api.malhaMUN(uf), api.resultadosMUN(uf)]);

    const porMun = {};
    for (const m of (res.municipios || [])) porMun[String(m.cd_mun)] = { cargos: m.cargos };

    const valores = [];
    for (const feat of geojson.features) {
      const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
      valores.push(extrairMetrica(porMun[cd] || { cargos: {} }, state.cargo));
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    const corBase = corBaseMetrica(ui._candidatos);

    mapa.render(
      geojson,
      (feat) => {
        const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
        const p = extrairMetrica(porMun[cd] || { cargos: {} }, state.cargo).pct;
        return { ...CONFIG.estiloGeoJSON, fillColor: corGradiente(p/maxPct, corBase) };
      },
      (feat, layer) => {
        const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
        const nome = feat.properties.NM_MUN || feat.properties.nm_mun;
        const met = extrairMetrica(porMun[cd] || { cargos: {} }, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> (${fmt.percentual(met.pct)})`,
          { sticky: true }
        );
      },
      (feat) => {
        const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
        const nome = feat.properties.NM_MUN || feat.properties.nm_mun;
        irParaMunicipio(uf, cd, nome);
      }
    );
    mapa.ajustarBounds();
    ui.renderLegenda(corBase, maxPct);
  }

  async function renderMUN(uf, cdMun, nomeMun) {
    state.camadaAtual = 'MUN';
    ui.setBreadcrumb([
      { nome: 'Brasil', nivel: 'BR' },
      { nome: uf, nivel: 'UF' },
      { nome: nomeMun, nivel: 'MUN' }
    ]);

    const [geojson, res] = await Promise.all([
      api.malhaLV(uf, cdMun),
      api.resultadosLV(state.cargo, uf)
    ]);

    const porLocal = {};
    for (const l of (res.locais || [])) porLocal[String(l.local_id)] = l;

    const valores = [];
    for (const feat of geojson.features) {
      const lid = String(feat.properties.local_id);
      valores.push(extrairMetrica(porLocal[lid] || {}, state.cargo));
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    const corBase = corBaseMetrica(ui._candidatos);

    mapa.render(
      geojson,
      (feat) => {
        const lid = String(feat.properties.local_id);
        const p = extrairMetrica(porLocal[lid] || {}, state.cargo).pct;
        return { ...CONFIG.estiloGeoJSON, fillColor: corGradiente(p/maxPct, corBase) };
      },
      (feat, layer) => {
        const lid = String(feat.properties.local_id);
        const nome = feat.properties.nm_local || lid;
        const met = extrairMetrica(porLocal[lid] || {}, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>Zona ${feat.properties.nr_zona} / Local ${feat.properties.nr_local}<br>` +
          `${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> (${fmt.percentual(met.pct)})`,
          { sticky: true }
        );
      },
      (feat) => ui.abrirPainelLocal(feat.properties, porLocal[String(feat.properties.local_id)])
    );
    mapa.ajustarBounds();
    ui.renderLegenda(corBase, maxPct);
  }

  async function irParaUF(uf) {
    state.uf = uf;
    state.municipio = null;
    await ui.carregarCandidatosDaUF(uf);
    ui.preencherMetricas();
    await renderUF(uf);
  }

  async function irParaMunicipio(uf, cdMun, nomeMun) {
    state.municipio = cdMun;
    await renderMUN(uf, cdMun, nomeMun);
  }

  async function voltar() {
    if (state.camadaAtual === 'MUN') await renderUF(state.uf);
    else if (state.camadaAtual === 'UF') { state.uf = null; state.municipio = null; await renderBR(); }
  }

  // ============================================================
  // 10. UI
  // ============================================================
  const ui = {
    _candidatos: [],

    nomeMetricaAtual() {
      const m = state.metrica;
      if (!m) return '—';
      if (m.startsWith('cand_')) {
        const nr = m.substring(5);
        const c = ui._candidatos.find(x => String(x.nr_candidato ?? x.nr_votavel) === nr);
        return c ? (c.nm_candidato || c.nm_votavel) : `Cand. ${nr}`;
      }
      return CONFIG.metricasEspeciais[m]?.nome || m;
    },

    async carregarCandidatosDaUF(uf) {
      const lista = [], vistos = new Set();
      if (uf) {
        const res = await api.resultadosMUN(uf);
        const bloco = res.cargos?.[CONFIG.cargos[state.cargo].nome] || {};
        for (const c of (bloco.candidatos || [])) {
          const nr = String(c.nr_candidato ?? c.nr_votavel);
          if (!vistos.has(nr)) { vistos.add(nr); lista.push(c); }
        }
      } else {
        const res = await api.resultadosBRAgregado();
        for (const sigla in res.ufs) {
          const bloco = res.ufs[sigla].cargos?.[CONFIG.cargos[state.cargo].nome] || {};
          for (const c of (bloco.candidatos || [])) {
            const nr = String(c.nr_candidato ?? c.nr_votavel);
            if (!vistos.has(nr)) { vistos.add(nr); lista.push(c); }
          }
        }
      }
      ui._candidatos = lista;
    },

    renderControles(elId) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.innerHTML = `
        <div class="ctrl-bloco"><label>Cargo</label>
          <select id="ctrl-cargo">
            ${Object.entries(CONFIG.cargos).map(([k,v]) =>
              `<option value="${k}" ${k===state.cargo?'selected':''}>${v.nome}</option>`).join('')}
          </select>
        </div>
        <div class="ctrl-bloco"><label>Métrica</label>
          <select id="ctrl-metrica"></select>
        </div>
        <div class="ctrl-bloco"><button id="btn-voltar">← Voltar</button></div>
      `;
      document.getElementById('ctrl-cargo').addEventListener('change', async (e) => {
        state.cargo = e.target.value;
        cache.resultadosLV = {};
        await ui.carregarCandidatosDaUF(state.uf);
        ui.preencherMetricas();
        if (state.camadaAtual === 'MUN') await renderMUN(state.uf, state.municipio, '');
        else if (state.camadaAtual === 'UF') await renderUF(state.uf);
        else await renderBR();
      });
      document.getElementById('ctrl-metrica').addEventListener('change', async (e) => {
        state.metrica = e.target.value;
        if (state.camadaAtual === 'MUN') await renderMUN(state.uf, state.municipio, '');
        else if (state.camadaAtual === 'UF') await renderUF(state.uf);
        else await renderBR();
      });
      document.getElementById('btn-voltar').addEventListener('click', voltar);
    },

    preencherMetricas() {
      const sel = document.getElementById('ctrl-metrica');
      if (!sel) return;
      const opts = [];
      for (const c of ui._candidatos) {
        const nr = String(c.nr_candidato ?? c.nr_votavel);
        const nome = c.nm_candidato || c.nm_votavel || nr;
        opts.push(`<option value="cand_${nr}">${nome}</option>`);
      }
      for (const k in CONFIG.metricasEspeciais) {
        opts.push(`<option value="${k}">${CONFIG.metricasEspeciais[k].nome}</option>`);
      }
      sel.innerHTML = opts.join('');
      if (!state.metrica || !opts.some(o => o.includes(`value="${state.metrica}"`))) {
        state.metrica = ui._candidatos.length
          ? `cand_${String(ui._candidatos[0].nr_candidato ?? ui._candidatos[0].nr_votavel)}`
          : 'brancos';
      }
      sel.value = state.metrica;
    },

    setBreadcrumb(partes) {
      const el = document.getElementById('breadcrumb');
      if (!el) return;
      el.innerHTML = partes.map((p, i) => {
        const sep = i > 0 ? ' <span class="sep">›</span> ' : '';
        return sep + `<span class="crumb" data-nivel="${p.nivel}">${p.nome}</span>`;
      }).join('');
      el.querySelectorAll('.crumb').forEach((c) => {
        c.addEventListener('click', () => {
          const n = c.dataset.nivel;
          if (n === 'BR') { state.uf = null; state.municipio = null; renderBR(); }
          else if (n === 'UF') renderUF(state.uf);
        });
      });
    },

    renderLegenda(corBase, maxPct) {
      const el = document.getElementById('legenda');
      if (!el) return;
      const passos = 6, amostras = [];
      for (let i = 0; i <= passos; i++) {
        const p = (i / passos) * maxPct;
        amostras.push({ cor: corGradiente(p/maxPct, corBase), pct: p });
      }
      el.innerHTML = `
        <div class="legenda-titulo">${ui.nomeMetricaAtual()}</div>
        <div class="legenda-gradiente">
          ${amostras.map(a => `<div class="legenda-cel" style="background:${a.cor}"></div>`).join('')}
        </div>
        <div class="legenda-valores">
          <span>0%</span><span>${fmt.percentual(maxPct)}</span>
        </div>
      `;
    },

    abrirPainelLocal(props, res) {
      const el = document.getElementById('painel');
      if (!el) return;
      if (!res) { el.innerHTML = ''; el.classList.remove('aberto'); return; }
      const cands = res.candidatos || [];
      const maxV = Math.max(1, ...cands.map(c => c.qt_votos));
      el.innerHTML = `
        <h3>${props.nm_local || 'Local'}</h3>
        <p class="painel-sub">Zona ${props.nr_zona} / Local ${props.nr_local}</p>
        <p class="painel-sub">${props.cd_mun || ''} ${props.area_km2 ? '· ' + Number(props.area_km2).toFixed(1) + ' km²' : ''}</p>
        <hr>
        <div class="painel-linha"><b>Comparecimento</b><span>${fmt.numero(res.comparecimento)}</span></div>
        <div class="painel-linha"><b>Brancos</b><span>${fmt.numero(res.brancos)}</span></div>
        <div class="painel-linha"><b>Nulos</b><span>${fmt.numero(res.nulos)}</span></div>
        <hr>
        <h4>Candidatos</h4>
        <ul class="painel-cands">
          ${cands.map(c => `
            <li>
              <div class="cand-top">
                <span>${c.nm_votavel || c.nm_candidato}</span>
                <span>${fmt.numero(c.qt_votos)}</span>
              </div>
              <div class="cand-bar" style="width:${(c.qt_votos/maxV*100).toFixed(1)}%"></div>
            </li>`).join('')}
        </ul>
      `;
      el.classList.add('aberto');
    }
  };

  // ============================================================
  // 11. INICIALIZAÇÃO
  // ============================================================
  const App = {
    async init({ mapaId = 'map', controlesId = 'controles' } = {}) {
      mapa.init(mapaId);
      ui.renderControles(controlesId);

      // Começa o download do ZIP em paralelo com a UI
      try {
        await carregarZip();
        await ui.carregarCandidatosDaUF(null);
        ui.preencherMetricas();
        await renderBR();
      } catch (err) {
        console.error('Erro ao inicializar:', err);
        const msg = document.getElementById('loader-msg');
        if (msg) msg.textContent = 'Erro: ' + err.message;
      }
    },
    state, cache, CONFIG, CORES_PARTIDOS,
    irParaUF, irParaMunicipio, voltar,
    renderBR, renderUF, renderMUN,
    utils: { corGradiente, corSecundaria, hexParaHsl, hslParaHex, fmt, pct }
  };

  window.VizinhancaApp = App;
})();
