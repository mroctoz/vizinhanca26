/* ============================================================
 * VIZINHANÇA 26 — Motor de visualização de resultados eleitorais
 * Versão 1.0
 *
 * Estrutura de dados esperada (basePath = /vizinhanca26):
 *   malha/UF/BR_UF_2025.json
 *   malha/UF/{UF}/{UF}.geojson
 *   malha/UF/{UF}/MUN/{MUN}/LV/areas_influencia_brasil/{cd_mun}.geojson
 *
 *   resultados/MUN/{UF}.json                    (níveis UF + MUN)
 *   resultados/presidenteLV/{UF}.json           (níveis UF + MUN + LV)
 *   resultados/governadorLV/{UF}.json
 *   resultados/senadorLV/{UF}.json
 *
 * Navegação: Brasil → UF → Município → Local de Votação
 * ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 1. CONFIGURAÇÃO
  // ============================================================

  const CONFIG = {
    basePath: '/vizinhanca26',

    // Cargos suportados
    cargos: {
      presidente: { nome: 'Presidente', arquivoLV: 'presidenteLV' },
      governador: { nome: 'Governador', arquivoLV: 'governadorLV' },
      senador:    { nome: 'Senador',    arquivoLV: 'senadorLV' }
    },

    // Métricas especiais (não-candidato) que podem ser exibidas
    metricasEspeciais: {
      brancos:        { nome: 'Brancos',        cor: '#9ca3af' },
      nulos:          { nome: 'Nulos',          cor: '#6b7280' },
      abstencoes:     { nome: 'Abstenções',     cor: '#374151' },
      comparecimento: { nome: 'Comparecimento', cor: '#1f2937' }
    },

    // UFs válidas (para montar caminhos)
    ufs: ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
          'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'],

    // Mapa base
    tiles: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    },

    // Estilo padrão do GeoJSON
    estiloGeoJSON: {
      weight: 1,
      color: '#ffffff',
      opacity: 0.9,
      fillOpacity: 0.85
    },

    // Zoom e centro iniciais (Brasil)
    centroInicial: [-15.78, -47.93],
    zoomInicial: 4
  };

  // ============================================================
  // 2. CORES DE PARTIDOS
  // ============================================================

  const CORES_PARTIDOS = {
    'PT':           '#de0000',
    'PL':           '#402386',
    'PSD':          '#99ad00',
    'Novo':         '#f58220',
    'Missão':       '#f6ae08',
    'Avante':       '#2ebf98',
    'UP':           '#009b3a',
    'PSTU':         '#a31b1b',
    'PCB':          '#cc0000',
    'PCO':          '#8b0000',
    'PRTB':         '#003399',
    'Democrata':    '#0055a5',
    'DC':           '#2a4d9c',
    'Republicanos': '#008f8c',
    'MDB':          '#028a00',
    'PDT':          '#d100ca',
    'PSOL':         '#ffcc00',
    'PSDB':         '#002fbd',
    'PSB':          '#ff2a00',
    'UNIÃO':        '#009eb3',
    'PP':           '#3c6baa',
    'PODEMOS':      '#2555a2',
    'PODE':         '#2555a2',
    'Agir':         '#06b6d4',
    'Mobiliza':     '#e74c3c',
    'Solidariedade':'#f97316',
    'Rede':         '#059669',
    'PRD':          '#d97706',
    'Outros':       '#8b5cf6'
  };

  // ============================================================
  // 3. ESTADO GLOBAL
  // ============================================================

  const state = {
    cargo: 'presidente',      // presidente | governador | senador
    metrica: null,            // 'cand_13' | 'brancos' | 'nulos' | 'abstencoes' | 'comparecimento'
    uf: null,                 // 'SP' | null
    municipio: null,          // '3550308' | null
    camadaAtual: 'BR',        // 'BR' | 'UF' | 'MUN' | 'LV'
    mapa: null,               // instância Leaflet
    camadaGeo: null,          // layer Leaflet atual
    legenda: null             // dados da legenda atual
  };

  // ============================================================
  // 4. CACHE DE DADOS (carregamento preguiçoso)
  // ============================================================

  const cache = {
    malhaBR: null,                   // GeoJSON das UFs
    malhaMUN: {},                    // { UF: GeoJSON }
    malhaLV: {},                     // { cd_mun: GeoJSON }
    resultadosMUN: {},               // { UF: resultados por MUN }
    resultadosLV: {},                // { cargo_UF: resultados por LV }
    resultadosBRagregado: null       // resultados por UF (calculado a partir de MUN)
  };

  // ============================================================
  // 5. UTILITÁRIOS
  // ============================================================

  // ---------- 5.1 Caminhos de arquivo ----------
  const path = {
    malhaUF:        () => `${CONFIG.basePath}/malha/UF/BR_UF_2025.json`,
    malhaMUN:       (uf) => `${CONFIG.basePath}/malha/UF/${uf}/${uf}.geojson`,
    malhaLV:        (uf, cdMun) =>
      `${CONFIG.basePath}/malha/UF/${uf}/MUN/${cdMun}/LV/areas_influencia_brasil/${cdMun}.geojson`,
    resultadosMUN:  (uf) => `${CONFIG.basePath}/resultados/MUN/${uf}.json`,
    resultadosLV:   (cargo, uf) =>
      `${CONFIG.basePath}/resultados/${CONFIG.cargos[cargo].arquivoLV}/${uf}.json`
  };

  // ---------- 5.2 Formatação ----------
  const fmt = {
    numero: (n) => (n == null ? '—' : n.toLocaleString('pt-BR')),
    percentual: (v) => (v == null ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%'),
    moeda: (n) => (n == null ? '—' : n.toLocaleString('pt-BR'))
  };

  // ---------- 5.3 Cores: interpolação HSL ----------
  /**
   * Converte "#rrggbb" em { h, s, l } (0-360, 0-1, 0-1)
   */
  function hexParaHsl(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substr(0, 2), 16) / 255;
    const g = parseInt(h.substr(2, 2), 16) / 255;
    const b = parseInt(h.substr(4, 2), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let hh, ss, ll = (max + min) / 2;
    if (max === min) { hh = ss = 0; }
    else {
      const d = max - min;
      ss = ll > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: hh = (g - b) / d + (g < b ? 6 : 0); break;
        case g: hh = (b - r) / d + 2; break;
        default: hh = (r - g) / d + 4;
      }
      hh /= 6;
    }
    return { h: hh * 360, s: ss, l: ll };
  }

  function hslParaHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    const toHex = (x) => {
      const v = Math.round(x * 255).toString(16);
      return v.length === 1 ? '0' + v : v;
    };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  /**
   * Gera a cor de preenchimento por gradiente em torno de uma cor-base.
   * pct = 0  → versão muito clara da cor-base (quase branca)
   * pct = 1  → cor-base saturada
   */
  function corGradiente(pct, corBase) {
    if (!corBase) corBase = '#888888';
    if (pct == null || isNaN(pct)) return '#f3f4f6';
    pct = Math.max(0, Math.min(1, pct));
    const { h, s } = hexParaHsl(corBase);
    // Extremos: saturação mínima + luminosidade alta → cor-base saturada
    const sMin = 0.15, sMax = s;
    const lMin = 0.92, lMax = 0.42;
    const sAtual = sMin + (sMax - sMin) * pct;
    const lAtual = lMin + (lMax - lMin) * pct;
    return hslParaHex(h, sAtual, lAtual);
  }

  /**
   * Retorna a cor secundária para o 2º candidato de um mesmo partido
   * (Senado). Estratégia: escurece ~20% e gira hue ~-25°.
   */
  function corSecundaria(corBase) {
    const { h, s, l } = hexParaHsl(corBase);
    return hslParaHex(h - 25, Math.min(1, s * 1.05), Math.max(0.15, l * 0.78));
  }

  /**
   * Descobre a qual partido pertence um candidato, dado o JSON de resultados.
   * O JSON de LV contém "candidatos": [{nr_votavel, nm_votavel, qt_votos}].
   * Aqui tentamos extrair o partido do nome. Se não achar, cai em "Outros".
   */
  function inferirPartido(nomeCandidato, cachePartidoCands) {
    if (cachePartidoCands && cachePartidoCands[nomeCandidato]) {
      return cachePartidoCands[nomeCandidato];
    }
    if (!nomeCandidato) return 'Outros';
    const up = nomeCandidato.toUpperCase();
    for (const sigla in CORES_PARTIDOS) {
      if (sigla.length >= 3 && up.includes(sigla.toUpperCase())) return sigla;
    }
    return 'Outros';
  }

  // ---------- 5.4 Cálculos ----------
  function pct(valor, total) {
    if (!total || total <= 0) return 0;
    return valor / total;
  }

  // ============================================================
  // 6. API — CARREGAMENTO DE DADOS
  // ============================================================

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Falha ao carregar ${url}: ${resp.status}`);
    return resp.json();
  }

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

    /**
     * Agrega todos os MUN de todas as UFs no nível nacional (por UF).
     * Usado para colorir o mapa do Brasil.
     */
    async resultadosBRAgregado() {
      if (cache.resultadosBRagregado) return cache.resultadosBRagregado;

      const agregado = { ufs: {} };

      for (const uf of CONFIG.ufs) {
        try {
          const r = await api.resultadosMUN(uf);
          // r.cargos é o total da UF; r.municipios é a lista
          agregado.ufs[uf] = {
            uf: uf,
            cargos: r.cargos || {}
          };
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
    /** Inicializa o Leaflet dentro do elemento informado. */
    init(elId) {
      state.mapa = L.map(elId, {
        center: CONFIG.centroInicial,
        zoom: CONFIG.zoomInicial,
        zoomControl: true,
        attributionControl: true
      });

      L.tileLayer(CONFIG.tiles.url, {
        attribution: CONFIG.tiles.attribution,
        maxZoom: 19
      }).addTo(state.mapa);
    },

    /** Remove a camada GeoJSON atual (se houver). */
    limpar() {
      if (state.camadaGeo) {
        state.mapa.removeLayer(state.camadaGeo);
        state.camadaGeo = null;
      }
    },

    /**
     * Renderiza uma camada GeoJSON com estilo por feature.
     * @param {Object} geojson  FeatureCollection
     * @param {Function} estiloFn  (feature) => estilo Leaflet
     * @param {Function} onEach  (feature, layer) => void
     * @param {Function} onClick  (feature) => void
     */
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

    /** Ajusta o zoom para enquadrar a camada atual. */
    ajustarBounds() {
      if (state.camadaGeo) {
        try {
          state.mapa.fitBounds(state.camadaGeo.getBounds(), { padding: [20, 20] });
        } catch (e) { /* ignora */ }
      }
    }
  };

  // ============================================================
  // 8. LÓGICA DE RENDERIZAÇÃO
  // ============================================================

  /**
   * Extrai de uma feature os valores da métrica atual (candidato ou especial),
   * junto com o total de referência (comparecimento), devolvendo um objeto
   * { valor, total, pct }.
   */
  function extrairMetrica(obj, cargoAtual) {
    const m = state.metrica;
    if (!m) return { valor: 0, total: 0, pct: 0 };

    // Cargo no formato do JSON de MUN: "Presidente", "Governador", "Senador"
    const nomeCargo = CONFIG.cargos[cargoAtual].nome;
    const cargos = obj.cargos || {};
    const bloco = cargos[nomeCargo] || {};

    const comparecimento = bloco.comparecimento || 0;
    const brancos        = bloco.brancos || 0;
    const nulos          = bloco.nulos || 0;
    const votosValidos   = bloco.votos_validos || 0;

    // Se for candidato ("cand_13")
    if (m.startsWith('cand_')) {
      const nr = m.substring(5);
      const cand = (bloco.candidatos || []).find(c =>
        String(c.nr_candidato ?? c.nr_votavel) === nr
      );
      const votos = cand ? (cand.qt_votos || 0) : 0;
      return { valor: votos, total: votosValidos, pct: pct(votos, votosValidos) };
    }

    // Métricas especiais
    switch (m) {
      case 'brancos':        return { valor: brancos,        total: comparecimento, pct: pct(brancos, comparecimento) };
      case 'nulos':          return { valor: nulos,          total: comparecimento, pct: pct(nulos, comparecimento) };
      case 'abstencoes':     return { valor: 0,              total: comparecimento, pct: 0 }; // preencher se houver dado
      case 'comparecimento': return { valor: comparecimento, total: comparecimento, pct: 1 };
    }
    return { valor: 0, total: 0, pct: 0 };
  }

  /**
   * Descobre a cor-base da métrica atual.
   *   - Candidato: cor do partido (primária ou secundária se for o 2º do mesmo partido)
   *   - Especial: cor fixa definida em CONFIG.metricasEspeciais
   */
  function corBaseMetrica(candidatosDisponiveis) {
    const m = state.metrica;
    if (!m) return '#888';

    if (m.startsWith('cand_')) {
      const nr = m.substring(5);
      const cand = candidatosDisponiveis.find(c =>
        String(c.nr_candidato ?? c.nr_votavel) === nr
      );
      if (!cand) return '#888';
      const partido = inferirPartido(cand.nm_candidato, candidatosDisponiveis._mapaPartidos);
      let cor = CORES_PARTIDOS[partido] || CORES_PARTIDOS['Outros'];

      // Senado: se já houver um candidato anterior do mesmo partido,
      // usa a cor secundária.
      if (state.cargo === 'senador') {
        const anteriores = candidatosDisponiveis.filter(c =>
          c !== cand &&
          inferirPartido(c.nm_candidato, candidatosDisponiveis._mapaPartidos) === partido
        );
        // Aplica secundária se este não for o "primeiro" do partido
        const idx = anteriores.length > 0 ? 1 : 0;
        if (idx === 1) cor = corSecundaria(cor);
      }
      return cor;
    }

    return CONFIG.metricasEspeciais[m]?.cor || '#888';
  }

  /**
   * Renderiza o mapa no nível Brasil (todas as UFs).
   */
  async function renderBR() {
    state.camadaAtual = 'BR';
    ui.setBreadcrumb([{ nome: 'Brasil', nivel: 'BR' }]);

    const [geojson, res] = await Promise.all([
      api.malhaBR(),
      api.resultadosBRAgregado()
    ]);

    // Descobre max pct para escala
    const valores = [];
    for (const feat of geojson.features) {
      const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
      const r = res.ufs[sigla];
      if (!r) continue;
      // Adapta: simulamos um "obj" no formato do extrairMetrica
      const obj = { cargos: r.cargos };
      const m = extrairMetrica(obj, state.cargo);
      valores.push(m);
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    ui.definirMaxPct(maxPct);

    const corBase = corBaseMetrica(ui.listaCandidatosAtual() || []);

    mapa.render(
      geojson,
      (feat) => {
        const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
        const r = res.ufs[sigla];
        let p = 0;
        if (r) {
          const obj = { cargos: r.cargos };
          p = extrairMetrica(obj, state.cargo).pct;
        }
        return {
          ...CONFIG.estiloGeoJSON,
          fillColor: corGradiente(p / maxPct, corBase)
        };
      },
      (feat, layer) => {
        const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
        const nome = feat.properties.NM_UF || sigla;
        const r = res.ufs[sigla];
        const obj = r ? { cargos: r.cargos } : { cargos: {} };
        const met = extrairMetrica(obj, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>` +
          `${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> ` +
          `(${fmt.percentual(met.pct)})`,
          { sticky: true }
        );
      },
      (feat) => {
        const sigla = feat.properties.SIGLA_UF || feat.properties.CD_UF;
        irParaUF(sigla);
      }
    );
    mapa.ajustarBounds();
    ui.renderLegenda(corBase, maxPct);
  }

  /**
   * Renderiza o mapa de uma UF (municípios).
   */
  async function renderUF(uf) {
    state.camadaAtual = 'UF';
    ui.setBreadcrumb([
      { nome: 'Brasil', nivel: 'BR' },
      { nome: uf, nivel: 'UF' }
    ]);

    const [geojson, res] = await Promise.all([
      api.malhaMUN(uf),
      api.resultadosMUN(uf)
    ]);

    // Mapa cd_mun → objeto com cargos
    const porMun = {};
    for (const m of (res.municipios || [])) {
      porMun[String(m.cd_mun)] = { cargos: m.cargos };
    }

    const valores = [];
    for (const feat of geojson.features) {
      const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
      const obj = porMun[cd] || { cargos: {} };
      valores.push(extrairMetrica(obj, state.cargo));
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    ui.definirMaxPct(maxPct);

    const corBase = corBaseMetrica(ui.listaCandidatosAtual() || []);

    mapa.render(
      geojson,
      (feat) => {
        const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
        const obj = porMun[cd] || { cargos: {} };
        const p = extrairMetrica(obj, state.cargo).pct;
        return {
          ...CONFIG.estiloGeoJSON,
          fillColor: corGradiente(p / maxPct, corBase)
        };
      },
      (feat, layer) => {
        const cd = String(feat.properties.CD_MUN || feat.properties.cd_mun);
        const nome = feat.properties.NM_MUN || feat.properties.nm_mun;
        const obj = porMun[cd] || { cargos: {} };
        const met = extrairMetrica(obj, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>` +
          `${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> ` +
          `(${fmt.percentual(met.pct)})`,
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

  /**
   * Renderiza o mapa de um município (locais de votação).
   */
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

    // Indexa LVs por local_id
    const porLocal = {};
    for (const l of (res.locais || [])) {
      porLocal[String(l.local_id)] = l;
    }

    const valores = [];
    for (const feat of geojson.features) {
      const lid = String(feat.properties.local_id);
      const obj = porLocal[lid] || {};
      valores.push(extrairMetrica(obj, state.cargo));
    }
    const maxPct = Math.max(0.01, ...valores.map(v => v.pct));
    ui.definirMaxPct(maxPct);

    const corBase = corBaseMetrica(ui.listaCandidatosAtual() || []);

    mapa.render(
      geojson,
      (feat) => {
        const lid = String(feat.properties.local_id);
        const obj = porLocal[lid] || {};
        const p = extrairMetrica(obj, state.cargo).pct;
        return {
          ...CONFIG.estiloGeoJSON,
          fillColor: corGradiente(p / maxPct, corBase)
        };
      },
      (feat, layer) => {
        const lid = String(feat.properties.local_id);
        const nome = feat.properties.nm_local || lid;
        const obj = porLocal[lid] || {};
        const met = extrairMetrica(obj, state.cargo);
        layer.bindTooltip(
          `<b>${nome}</b><br>` +
          `Zona ${feat.properties.nr_zona} / Local ${feat.properties.nr_local}<br>` +
          `${ui.nomeMetricaAtual()}: <b>${fmt.numero(met.valor)}</b> ` +
          `(${fmt.percentual(met.pct)})`,
          { sticky: true }
        );
      },
      (feat) => {
        // Clique em LV: por ora, só exibe tooltip mais rico (pode abrir painel)
        ui.abrirPainelLocal(feat.properties, porLocal[String(feat.properties.local_id)]);
      }
    );
    mapa.ajustarBounds();
    ui.renderLegenda(corBase, maxPct);
  }

  // ---------- Navegação ----------
  async function irParaUF(uf) {
    state.uf = uf;
    state.municipio = null;
    await ui.carregarCandidatosDaUF(uf);
    await renderUF(uf);
  }

  async function irParaMunicipio(uf, cdMun, nomeMun) {
    state.municipio = cdMun;
    await renderMUN(uf, cdMun, nomeMun);
  }

  async function voltar() {
    if (state.camadaAtual === 'MUN') {
      await renderUF(state.uf);
    } else if (state.camadaAtual === 'UF') {
      state.uf = null;
      state.municipio = null;
      await renderBR();
    }
  }

  // ============================================================
  // 9. UI — CONTROLES E LEGENDA
  // ============================================================

  const ui = {
    _candidatos: [],   // candidatos da UF atual (ou nacionais)
    _maxPct: 0,

    /** Retorna o nome legível da métrica atual. */
    nomeMetricaAtual() {
      const m = state.metrica;
      if (!m) return '—';
      if (m.startsWith('cand_')) {
        const nr = m.substring(5);
        const c = ui._candidatos.find(x =>
          String(x.nr_candidato ?? x.nr_votavel) === nr
        );
        return c ? (c.nm_candidato || c.nm_votavel) : `Cand. ${nr}`;
      }
      return CONFIG.metricasEspeciais[m]?.nome || m;
    },

    /** Retorna a lista atual de candidatos (usada pelo corBaseMetrica). */
    listaCandidatosAtual() {
      return ui._candidatos;
    },

    /** Guarda o maior percentual para a legenda. */
    definirMaxPct(v) { ui._maxPct = v; },

    /**
     * Carrega os candidatos de uma UF (a partir do arquivo MUN/{UF}.json).
     * Se UF for null, agrega os candidatos nacionais.
     */
    async carregarCandidatosDaUF(uf) {
      const lista = [];
      const vistos = new Set();

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

    /** Renderiza o seletor de cargo e métrica. */
    renderControles(elId) {
      const el = document.getElementById(elId);
      if (!el) return;

      const html = `
        <div class="ctrl-bloco">
          <label>Cargo</label>
          <select id="ctrl-cargo">
            ${Object.entries(CONFIG.cargos).map(([k, v]) =>
              `<option value="${k}" ${k === state.cargo ? 'selected' : ''}>${v.nome}</option>`
            ).join('')}
          </select>
        </div>

        <div class="ctrl-bloco">
          <label>Métrica</label>
          <select id="ctrl-metrica"></select>
        </div>

        <div class="ctrl-bloco">
          <button id="btn-voltar">← Voltar</button>
        </div>
      `;
      el.innerHTML = html;

      document.getElementById('ctrl-cargo').addEventListener('change', async (e) => {
        state.cargo = e.target.value;
        ui._candidatos = [];
        cache.resultadosLV = {}; // limpa cache de LV ao trocar cargo
        // Recarrega candidatos da UF atual
        if (state.uf) await ui.carregarCandidatosDaUF(state.uf);
        else await ui.carregarCandidatosDaUF(null);
        ui.preencherMetricas();
        // Re-renderiza a camada atual
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

    /** Preenche o dropdown de métricas com candidatos + especiais. */
    preencherMetricas() {
      const sel = document.getElementById('ctrl-metrica');
      if (!sel) return;

      const opts = [];
      // Candidatos
      for (const c of ui._candidatos) {
        const nr = String(c.nr_candidato ?? c.nr_votavel);
        const nome = c.nm_candidato || c.nm_votavel || nr;
        opts.push(`<option value="cand_${nr}">${nome}</option>`);
      }
      // Especiais
      for (const k in CONFIG.metricasEspeciais) {
        opts.push(`<option value="${k}">${CONFIG.metricasEspeciais[k].nome}</option>`);
      }
      sel.innerHTML = opts.join('');

      // Seleciona a métrica atual ou a primeira
      if (!state.metrica || !opts.some(o => o.includes(`value="${state.metrica}"`))) {
        state.metrica = ui._candidatos.length
          ? `cand_${String(ui._candidatos[0].nr_candidato ?? ui._candidatos[0].nr_votavel)}`
          : 'brancos';
      }
      sel.value = state.metrica;
    },

    /** Atualiza o breadcrumb. */
    setBreadcrumb(partes) {
      const el = document.getElementById('breadcrumb');
      if (!el) return;
      el.innerHTML = partes.map((p, i) => {
        const sep = i > 0 ? ' <span class="sep">›</span> ' : '';
        return sep + `<span class="crumb" data-nivel="${p.nivel}">${p.nome}</span>`;
      }).join('');
      // Clique para voltar
      el.querySelectorAll('.crumb').forEach((c) => {
        c.addEventListener('click', () => {
          const n = c.dataset.nivel;
          if (n === 'BR') { state.uf = null; state.municipio = null; renderBR(); }
          else if (n === 'UF') { renderUF(state.uf); }
        });
      });
    },

    /** Renderiza a legenda em gradiente. */
    renderLegenda(corBase, maxPct) {
      const el = document.getElementById('legenda');
      if (!el) return;

      const passos = 6;
      const amostras = [];
      for (let i = 0; i <= passos; i++) {
        const pct = (i / passos) * maxPct;
        amostras.push({
          cor: corGradiente(pct / maxPct, corBase),
          pct: pct
        });
      }

      el.innerHTML = `
        <div class="legenda-titulo">${ui.nomeMetricaAtual()}</div>
        <div class="legenda-gradiente">
          ${amostras.map(a =>
            `<div class="legenda-cel" style="background:${a.cor}"></div>`
          ).join('')}
        </div>
        <div class="legenda-valores">
          <span>0%</span>
          <span>${fmt.percentual(maxPct)}</span>
        </div>
        <div class="legenda-escala">
          ${amostras.map(a =>
            `<span>${(a.pct * 100).toFixed(1)}%</span>`
          ).join('')}
        </div>
      `;
    },

    /** Painel lateral com detalhes de um local de votação. */
    abrirPainelLocal(props, res) {
      const el = document.getElementById('painel');
      if (!el) return;
      if (!res) { el.innerHTML = ''; el.classList.remove('aberto'); return; }

      const nomeCargo = CONFIG.cargos[state.cargo].nome;
      const bloco = res[nomeCargo.toLowerCase()] || res;

      // Vamos usar o formato do JSON de LV: candidatos[] direto
      const cands = res.candidatos || [];
      const maxV = Math.max(1, ...cands.map(c => c.qt_votos));

      el.innerHTML = `
        <h3>${props.nm_local || 'Local'}</h3>
        <p class="painel-sub">Zona ${props.nr_zona} / Local ${props.nr_local}</p>
        <p class="painel-sub">${props.cd_mun} — ${props.area_km2 ? props.area_km2.toFixed(1) + ' km²' : ''}</p>
        <hr>
        <div class="painel-linha"><b>Comparecimento</b><span>${fmt.numero(res.comparecimento)}</span></div>
        <div class="painel-linha"><b>Brancos</b><span>${fmt.numero(res.brancos)}</span></div>
        <div class="painel-linha"><b>Nulos</b><span>${fmt.numero(res.nulos)}</span></div>
        <div class="painel-linha"><b>Abstenções</b><span>${fmt.numero(res.abstencoes)}</span></div>
        <hr>
        <h4>Candidatos</h4>
        <ul class="painel-cands">
          ${cands.map(c => `
            <li>
              <div class="cand-top">
                <span>${c.nm_votavel || c.nm_candidato}</span>
                <span>${fmt.numero(c.qt_votos)}</span>
              </div>
              <div class="cand-bar" style="width:${(c.qt_votos / maxV * 100).toFixed(1)}%"></div>
            </li>
          `).join('')}
        </ul>
      `;
      el.classList.add('aberto');
    }
  };

  // ============================================================
  // 10. API PÚBLICA E INICIALIZAÇÃO
  // ============================================================

  const App = {
    init({ mapaId = 'map', controlesId = 'controles' } = {}) {
      mapa.init(mapaId);
      ui.renderControles(controlesId);
      ui.carregarCandidatosDaUF(null).then(() => {
        ui.preencherMetricas();
        renderBR();
      });
    },

    // Exposição para debug e para o index.html
    state,
    cache,
    CONFIG,
    CORES_PARTIDOS,
    irParaUF,
    irParaMunicipio,
    voltar,
    renderBR,
    renderUF,
    renderMUN,
    utils: { corGradiente, corSecundaria, hexParaHsl, hslParaHex, fmt, pct }
  };

  window.VizinhancaApp = App;
})();