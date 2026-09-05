/* ============================================================
   PEDIDOS LAGOA — núcleo do app
   ============================================================
   Aqui fica o que TODAS as telas usam: login, tema da marca,
   conversa com o banco, pop-ups, avisos e o tempo real.

   As telas em si moram em arquivos separados, e cada uma se
   apresenta chamando PL.registrarTela(...):
      quiosque.js  → cardápios, dicas e o carrinho
      recepcao.js  → o quadro de pedidos
      admin.js     → a engrenagem ⚙ (configurações e cadastros)

   REGRA DE NOMES (para não se perder): os dados vêm do banco com
   os nomes das COLUNAS em inglês (price_cents, kiosk_id...). Eles
   ficam como estão, sem tradução, para não haver dois nomes para a
   mesma coisa. Tudo que é texto de tela e nome de função é em
   português.
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.PEDIDOS_CONFIG || {};

  // Versão do programa (aparece no rodapé das configurações). É LIDA do
  // "?v=" da própria tag <script> que carregou este arquivo: assim existe
  // um número só para manter, o do endereço, e ele nunca fica defasado.
  const VERSAO = (function () {
    try {
      const s = document.currentScript ||
        Array.prototype.slice.call(document.scripts).filter((x) => /app\.js/.test(x.src)).pop();
      const m = s && s.src && s.src.match(/[?&]v=([^&]+)/);
      return m ? "v" + m[1] : "?";
    } catch (e) { return "?"; }
  })();

  // ------------------------------------------------------------------
  //  ATALHOS
  // ------------------------------------------------------------------
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const MAPA_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(v) {
    return String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => MAPA_ESC[c]);
  }

  // O banco guarda preço em CENTAVOS (número inteiro). Dinheiro em número
  // quebrado dá erro de arredondamento — 0,1 + 0,2 não dá 0,3 no computador.
  function dinheiro(centavos) {
    const n = Number(centavos || 0) / 100;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function minutosDesde(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  }

  // 0 → "agora" | 7 → "7 min" | 95 → "1h35"
  function tempoCurto(min) {
    const m = Math.max(0, Math.round(min || 0));
    if (m < 1) return "agora";
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0");
  }

  function hora(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // Data de HOJE no fuso do estabelecimento, no formato aaaa-mm-dd.
  // Usar a data do tablet daria errado num aparelho com o fuso trocado —
  // e o "dia" do sistema precisa bater com o que o banco calculou.
  function hojeNoFuso(fuso) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: fuso || "America/Sao_Paulo",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function aguarde(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // "11:00:00" ou "11:00" → minutos desde a meia-noite
  function minutosDaHora(hora) {
    const m = String(hora || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // Que horas são agora no relógio DA CASA (e não no do tablet, que pode
  // estar com o fuso trocado).
  function relogioDaCasa(fuso) {
    try {
      const partes = {};
      new Intl.DateTimeFormat("en-CA", {
        timeZone: fuso || "America/Sao_Paulo",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date()).forEach((p) => { partes[p.type] = p.value; });
      return Number(partes.hour) * 60 + Number(partes.minute);
    } catch (e) {
      const d = new Date();
      return d.getHours() * 60 + d.getMinutes();
    }
  }

  // ------------------------------------------------------------------
  //  A CONTA ABERTA DE CADA QUIOSQUE  (o "turno")
  //  ------------------------------------------------------------------
  //  Tem dia com pesca de dia e pesca de noite: o mesmo quiosque troca de
  //  gente, e a conta de quem foi embora não pode aparecer para quem
  //  chegou. A conta zera de dois jeitos:
  //     · a recepção encerra na mão (botão que aparece a partir das 18h)
  //     · sozinha, quando passa a hora de virada (04:00 por padrão)
  //  Vale sempre a MAIS RECENTE das duas.
  //
  //  A hora de virada é 04:00 e não meia-noite de propósito: pescaria que
  //  vai até as 2h da manhã ainda é a mesma noite, e a conta não pode
  //  virar no meio dela.
  // ------------------------------------------------------------------
  function ultimaViradaAutomatica(cliente) {
    const c = cliente || {};
    const corte = minutosDaHora(c.sessao_zera_as);
    if (corte === null) return 0;
    const agora = relogioDaCasa(c.timezone);
    // quantos minutos se passaram desde a última vez que o relógio da casa
    // cruzou aquela hora (se ainda não cruzou hoje, foi ontem)
    const desde = ((agora - corte) + 1440) % 1440;
    // Os segundos do relógio saem da conta de propósito: sem isso a
    // fronteira do turno andaria um pouquinho a cada chamada, e um pedido
    // feito exatamente na virada entraria ou sairia da conta conforme a
    // hora em que a tela foi desenhada.
    const agoraMs = Date.now();
    return (agoraMs - (agoraMs % 60000)) - desde * 60000;
  }

  function inicioDaSessao(quiosque) {
    const manual = quiosque && quiosque.session_started_at
      ? new Date(quiosque.session_started_at).getTime() : 0;
    return Math.max(manual || 0, ultimaViradaAutomatica(ctx && ctx.cliente));
  }

  // Já passou da hora em que o botão "encerrar contas" deve aparecer?
  function horaDeEncerrar() {
    const c = (ctx && ctx.cliente) || {};
    const corte = minutosDaHora(c.turno_botao_das);
    if (corte === null) return false;
    return relogioDaCasa(c.timezone) >= corte;
  }

  // Os pedidos que contam para a conta aberta daquele quiosque.
  function pedidosDaSessao(quiosque) {
    const desde = inicioDaSessao(quiosque);
    const id = quiosque && quiosque.id;
    return (pedidos || []).filter((p) =>
      (!id || p.kiosk_id === id) && new Date(p.created_at).getTime() >= desde);
  }

  function adiar(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  // ------------------------------------------------------------------
  //  ESTADOS DO PEDIDO
  //  O caminho é curto de propósito: o pedido chega, a recepção lança,
  //  acabou. Não existe etapa entre uma coisa e outra — e é daqui que
  //  saem os botões do quadro.
  // ------------------------------------------------------------------
  const STATUS = {
    recebido:  { rotulo: "A lançar",      curto: "Novo",      icone: "🔔" },
    lancado:   { rotulo: "Lançado",       curto: "Lançado",   icone: "✅" },
    erro:      { rotulo: "Pedido errado", curto: "Errado",    icone: "⚠️" },
    cancelado: { rotulo: "Cancelado",     curto: "Cancelado", icone: "✖"  },
  };
  const ABERTOS = ["recebido"];
  const FECHADOS = ["lancado", "erro", "cancelado"];

  // Nomes que o app usa ⇄ nomes reais das tabelas no banco.
  // Ter um lugar só com essa tradução evita erro de digitação espalhado.
  const TABELAS = {
    quiosques:   "kiosks",
    secoes:      "sections",
    categorias:  "categories",
    produtos:    "products",
    dicas:       "tips",
    propagandas: "ads",
  };

  // ------------------------------------------------------------------
  //  ESTADO
  // ------------------------------------------------------------------
  let backend = null;
  let ctx = null;             // { perfil, cliente, quiosque }
  let catalogo = { secoes: [], categorias: [], produtos: [], dicas: [], quiosques: [] };
  let pedidos = [];           // pedidos do dia (o que o perfil pode ver)
  let telas = [];             // telas registradas pelos outros arquivos
  let telaAtiva = null;
  let ouvintes = {};          // barramento de eventos interno
  let semRede = false;

  // ==================================================================
  //  EVENTOS
  //  Um aviso simples entre os arquivos: quem muda dado chama emitir(),
  //  quem desenha tela chama ao(). Ninguém precisa conhecer o outro.
  // ==================================================================
  function ao(evento, fn) {
    (ouvintes[evento] = ouvintes[evento] || []).push(fn);
  }
  function emitir(evento, dado) {
    (ouvintes[evento] || []).forEach((fn) => {
      try { fn(dado); } catch (e) { console.error("Erro no ouvinte de " + evento, e); }
    });
  }

  // ==================================================================
  //  AVISOS FLUTUANTES  (toast)
  // ==================================================================
  function aviso(texto, tipo) {
    const caixa = $("#toasts");
    if (!caixa) return;
    const el = document.createElement("div");
    el.className = "toast" + (tipo ? " " + tipo : "");
    el.textContent = texto;
    caixa.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 320);
    }, tipo === "erro" ? 5200 : 2800);
  }

  // ==================================================================
  //  POP-UPS
  //  modal({...}) devolve um objeto com .fechar() e .caixa (o elemento).
  //  Vários pop-ups podem ficar empilhados: a engrenagem do admin abre
  //  por cima da tela normal sem fechar nada.
  // ==================================================================
  function modal(opcoes) {
    const o = Object.assign({
      titulo: "", corpo: "", larga: false, botoes: [], abas: null,
      aoAbrir: null, aoFechar: null, fecharNoFundo: true,
    }, opcoes || {});

    const fundo = document.createElement("div");
    fundo.className = "modal";

    const abasHtml = o.abas && o.abas.length
      ? `<div class="modal-abas">${o.abas.map((a, i) =>
          `<button type="button" class="modal-aba${i === 0 ? " is-active" : ""}" data-aba="${esc(a.id)}">${esc(a.rotulo)}</button>`
        ).join("")}</div>`
      : "";

    fundo.innerHTML = `
      <div class="modal-box${o.larga ? " larga" : ""}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>${esc(o.titulo)}</h2>
          <button type="button" class="modal-x" aria-label="Fechar">✕</button>
        </div>
        ${abasHtml}
        <div class="modal-corpo"></div>
        ${o.botoes.length ? '<div class="modal-pe"></div>' : ""}
      </div>`;

    const caixa  = $(".modal-box", fundo);
    const corpo  = $(".modal-corpo", fundo);
    const pe     = $(".modal-pe", fundo);

    function fechar() {
      fundo.remove();
      if (!$("#modais .modal")) document.body.style.overflow = "";
      if (o.aoFechar) o.aoFechar();
    }

    // conteúdo: aceita texto com HTML pronto ou um elemento já montado
    function preencher(conteudo) {
      corpo.innerHTML = "";
      if (conteudo instanceof HTMLElement) corpo.appendChild(conteudo);
      else corpo.innerHTML = conteudo || "";
    }
    preencher(o.abas && o.abas.length ? o.abas[0].corpo : o.corpo);

    if (o.abas && o.abas.length) {
      $$(".modal-aba", fundo).forEach((b) => {
        b.addEventListener("click", () => {
          $$(".modal-aba", fundo).forEach((x) => x.classList.remove("is-active"));
          b.classList.add("is-active");
          const aba = o.abas.find((a) => a.id === b.dataset.aba);
          if (!aba) return;
          preencher(typeof aba.corpo === "function" ? aba.corpo() : aba.corpo);
          if (aba.aoAbrir) aba.aoAbrir(corpo, api);
        });
      });
    }

    (o.botoes || []).forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn " + (b.classe || "btn-neutral");
      btn.textContent = b.texto;
      if (b.id) btn.id = b.id;
      btn.addEventListener("click", () => b.acao ? b.acao(fechar, api) : fechar());
      pe.appendChild(btn);
    });

    $(".modal-x", fundo).addEventListener("click", fechar);
    if (o.fecharNoFundo) {
      fundo.addEventListener("mousedown", (e) => { if (e.target === fundo) fechar(); });
    }

    const api = { fundo, caixa, corpo, fechar, preencher };

    $("#modais").appendChild(fundo);
    document.body.style.overflow = "hidden";
    if (o.aoAbrir) o.aoAbrir(corpo, api);
    return api;
  }

  // Pergunta de sim ou não. Devolve uma promessa: true = confirmou.
  function confirmar(opcoes) {
    const o = Object.assign({
      titulo: "Confirmar", texto: "", ok: "Confirmar", cancelar: "Voltar", perigo: false,
    }, opcoes || {});
    return new Promise((resolve) => {
      let respondeu = false;
      const m = modal({
        titulo: o.titulo,
        corpo: `<p style="margin:0;line-height:1.55">${o.texto}</p>`,
        botoes: [
          { texto: o.cancelar, classe: "btn-neutral", acao: (f) => { respondeu = true; f(); resolve(false); } },
          { texto: o.ok, classe: o.perigo ? "btn-danger" : "btn-primary",
            acao: (f) => { respondeu = true; f(); resolve(true); } },
        ],
        aoFechar: () => { if (!respondeu) resolve(false); },
      });
      const btn = m.fundo.querySelectorAll(".modal-pe .btn")[1];
      if (btn) setTimeout(() => btn.focus(), 60);
    });
  }

  // Aviso curto de "deu certo / deu errado" sem pop-up.
  function erroLegivel(e) {
    if (!e) return "Não deu certo.";
    const t = String(e.message || e.error_description || e || "");
    if (/Invalid login credentials/i.test(t)) return "Usuário ou senha não confere.";
    if (/Failed to fetch|NetworkError|network/i.test(t)) return "Sem internet. Confira a conexão do tablet.";
    if (/JWT|token|expired/i.test(t)) return "A sessão expirou. Entre de novo.";
    // O caso do armazenamento vem ANTES do "sem permissão" genérico: as duas
    // mensagens falam em row-level security, e a genérica ganharia — deixando
    // quem lê sem saber que o problema é o 09 que faltou rodar.
    if (/row-level security/i.test(t) && /storage|object|bucket/i.test(t)) {
      return "Sem permissão para enviar a foto. Rode o 09-fotos-do-cardapio.sql no Supabase.";
    }
    if (/permission denied|42501|row-level security/i.test(t)) return "Este perfil não tem permissão para isso.";
    if (/duplicate key|already exists/i.test(t)) return "Já existe um registro com esse nome.";
    // Função ou coluna que o app usa mas que o banco ainda não tem: quase
    // sempre é um arquivo SQL que ficou para trás. Dizer isso em português
    // poupa meia hora de procura.
    // "Could not find the function/table/column ... in the schema cache"
    if (/Could not find the .*(function|table|column)|PGRST20[0-9]/i.test(t)) {
      return "Falta rodar um arquivo SQL no Supabase — este recurso ainda não existe no banco.";
    }
    if (/column .* does not exist|42703/i.test(t)) {
      return "O banco está numa versão anterior à do aplicativo. Rode os arquivos SQL que faltam.";
    }
    // Armazenamento das fotos ainda não existe ou está fechado
    if (/bucket not found/i.test(t)) {
      return "O armazenamento de fotos ainda não foi criado. Rode o 09-fotos-do-cardapio.sql no Supabase.";
    }
    if (/payload too large|exceeded the maximum allowed size/i.test(t)) {
      return "A imagem ficou grande demais. Tente uma foto menor.";
    }
    return t || "Não deu certo.";
  }

  // ==================================================================
  //  SOM DE PEDIDO NOVO
  //  Feito na hora pelo próprio navegador (sem arquivo de áudio para
  //  baixar). Só toca depois que alguém encostou na tela — os
  //  navegadores bloqueiam som antes disso.
  // ==================================================================
  let audioCtx = null;
  let podeTocar = false;
  ["click", "touchstart", "keydown"].forEach((ev) =>
    window.addEventListener(ev, () => { podeTocar = true; }, { once: true, passive: true })
  );

  function tocarAviso(vezes) {
    if (!podeTocar) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const n = Math.max(1, vezes || 2);
      for (let i = 0; i < n; i++) {
        const osc = audioCtx.createOscillator();
        const vol = audioCtx.createGain();
        const t0 = audioCtx.currentTime + i * 0.22;
        osc.type = "sine";
        osc.frequency.setValueAtTime(i % 2 ? 1046 : 784, t0);
        vol.gain.setValueAtTime(0.0001, t0);
        vol.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
        vol.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.19);
        osc.connect(vol); vol.connect(audioCtx.destination);
        osc.start(t0); osc.stop(t0 + 0.2);
      }
    } catch (e) { /* som é enfeite: nunca pode derrubar o app */ }
  }

  function vibrar(padrao) {
    try { if (navigator.vibrate) navigator.vibrate(padrao || [120, 60, 120]); } catch (e) {}
  }

  // ==================================================================
  //  MANTER A TELA ACESA
  //  ------------------------------------------------------------------
  //  O tablet do quiosque fica o dia inteiro no balcão. Se a tela apagar,
  //  o garçom precisa acordar e destravar o aparelho antes de cada
  //  pedido — e aí ele volta a gritar o pedido pela lagoa.
  //
  //  O navegador só concede isso enquanto a página está À VISTA, e a
  //  permissão se perde quando o aparelho é minimizado. Por isso a gente
  //  pede de novo toda vez que a página volta a aparecer.
  //
  //  Isto NÃO substitui ajustar o tablet: se o Android estiver com
  //  bloqueio de tela em 30 s, ele ainda vai bloquear quando o app sair
  //  da frente. O certo é deixar o aparelho sem bloqueio e na tomada.
  // ==================================================================
  let travaDeTela = null;

  async function manterTelaAcesa() {
    if (!("wakeLock" in navigator)) return false;
    try {
      travaDeTela = await navigator.wakeLock.request("screen");
      travaDeTela.addEventListener("release", () => { travaDeTela = null; });
      return true;
    } catch (e) {
      // negado, bateria fraca, navegador antigo: não é motivo para
      // atrapalhar nada — o app funciona igual, só apaga a tela
      console.warn("Manter a tela acesa:", e && e.message);
      return false;
    }
  }

  function soltarTelaAcesa() {
    try { if (travaDeTela) travaDeTela.release(); } catch (e) {}
    travaDeTela = null;
  }

  function quererTelaAcesa() {
    const c = (ctx && ctx.cliente) || {};
    if (c.screen_keep_awake === false) return false;
    if (CFG.manterTelaAcesa === false) return false;
    // só no tablet do quiosque: no celular do cliente seria abuso de bateria
    return ehQuiosque() && !ehPublico();
  }

  function cuidarDaTelaAcesa() {
    if (!quererTelaAcesa()) { soltarTelaAcesa(); return; }
    if (document.visibilityState === "visible" && !travaDeTela) manterTelaAcesa();
  }

  // ==================================================================
  //  TEMA DA MARCA (white-label)
  //  As cores saem da linha do cliente na tabela `tenants`. Trocar de
  //  cliente é trocar aquela linha — nada de mexer no CSS.
  // ==================================================================
  function aplicarTema(cliente) {
    const c = cliente || {};
    const raiz = document.documentElement.style;
    if (c.primary_color) {
      raiz.setProperty("--brand", c.primary_color);
      raiz.setProperty("--brand-dark", escurecer(c.primary_color, 0.22));
      raiz.setProperty("--brand-soft", clarear(c.primary_color, 0.88));
      raiz.setProperty("--teal", clarear(c.primary_color, 0.12));
      const meta = $("#metaTema");
      if (meta) meta.setAttribute("content", c.primary_color);
    }
    if (c.accent_color) {
      raiz.setProperty("--accent", c.accent_color);
      raiz.setProperty("--accent-dark", escurecer(c.accent_color, 0.2));
    }

    const nome = c.name || CFG.marca || "Pedidos";
    const sub  = c.legal_name || CFG.estabelecimento || "";
    if ($("#brandNome")) $("#brandNome").textContent = nome;
    if ($("#brandSub"))  $("#brandSub").textContent  = sub;
    if ($("#loginMarca")) $("#loginMarca").textContent = nome;
    if ($("#loginSub"))   $("#loginSub").textContent   = sub;
    document.title = nome;

    if (c.logo_url) {
      ["#brandLogo", ".login-logo"].forEach((sel) => {
        const img = $(sel);
        if (img) img.src = c.logo_url;
      });
    }
  }

  function corParaRgb(hex) {
    const h = String(hex || "").replace("#", "");
    const c = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
    const n = parseInt(c, 16);
    if (isNaN(n) || c.length !== 6) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function escurecer(hex, q) {
    const c = corParaRgb(hex); if (!c) return hex;
    const f = (v) => Math.round(v * (1 - q));
    return "#" + [f(c.r), f(c.g), f(c.b)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function clarear(hex, q) {
    const c = corParaRgb(hex); if (!c) return hex;
    const f = (v) => Math.round(v + (255 - v) * q);
    return "#" + [f(c.r), f(c.g), f(c.b)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  // ==================================================================
  //  BANCO — versão SUPABASE (a de verdade)
  // ==================================================================
  function BackendSupabase(url, chave) {
    const sb = window.supabase.createClient(url, chave, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "pedidos_lagoa_sessao" },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    // Toda leitura passa por aqui: assim um erro de rede vira uma
    // mensagem em português em vez de um objeto cru no console.
    async function ok(promessa) {
      const { data, error } = await promessa;
      if (error) throw error;
      return data;
    }

    async function lerContexto() {
      const d = await ok(sb.rpc("my_context"));
      if (!d || !d.profile) return null;
      return { perfil: d.profile, cliente: d.tenant, quiosque: d.kiosk || null };
    }

    return {
      tipo: "supabase",
      sb,

      async sessao() {
        const { data } = await sb.auth.getSession();
        if (!data || !data.session) return null;
        return lerContexto();
      },

      async entrar(email, senha) {
        await ok(sb.auth.signInWithPassword({ email, password: senha }));
        const c = await lerContexto();
        if (!c) {
          await sb.auth.signOut();
          throw new Error("Este login existe, mas ainda não tem perfil no sistema. Rode o 06-usuarios.sql.");
        }
        return c;
      },

      async sair() { try { await sb.auth.signOut(); } catch (e) {} },

      async carregarCatalogo() {
        const [secoes, categorias, produtos, dicas, quiosques, propagandas] = await Promise.all([
          ok(sb.from("sections").select("*").order("sort_order")),
          ok(sb.from("categories").select("*").order("sort_order")),
          ok(sb.from("products").select("*").order("sort_order")),
          ok(sb.from("tips").select("*").order("pinned", { ascending: false }).order("sort_order")),
          ok(sb.from("kiosks").select("*").order("number")),
          // A tabela de propaganda nasceu no 10. Quem ainda não rodou aquele
          // arquivo continua com o app inteiro funcionando — só sem anúncio.
          ok(sb.from("ads").select("*").order("sort_order")).catch(() => []),
        ]);
        return { secoes, categorias, produtos, dicas, quiosques, propagandas };
      },

      async carregarPedidos(dia) {
        return ok(
          sb.from("orders")
            .select("*, quiosque:kiosks(id,number,name), itens:order_items(*)")
            .eq("service_date", dia)
            .order("created_at", { ascending: false })
        );
      },

      async criarPedido(p) {
        return ok(sb.rpc("place_order", {
          p_items: p.itens,
          p_notes: p.observacao || null,
          p_customer_name: p.cliente || null,
          p_table_label: p.lugar || null,
          p_kiosk_id: p.quiosqueId || null,
        }));
      },

      async mudarStatus(id, status, motivo) {
        return ok(sb.rpc("set_order_status", {
          p_order_id: id, p_status: status, p_reason: motivo || null,
        }));
      },

      async marcarVistos(ids) {
        if (!ids || !ids.length) return 0;
        return ok(sb.rpc("ack_orders", { p_ids: ids }));
      },

      // Encerra a conta dos quiosques escolhidos. Quem nao veio na lista
      // continua como esta — e assim o quiosque que vira a noite mantem a
      // conta aberta.
      async fecharSessoes(ids) {
        if (!ids || !ids.length) return 0;
        return ok(sb.rpc("fechar_sessao_quiosques", { p_ids: ids }));
      },

      // Manda a foto para o armazenamento e devolve o endereço público.
      // O nome do arquivo é sorteado e leva o id do cliente na frente:
      // dois estabelecimentos no mesmo banco nunca escrevem um por cima
      // do outro, e trocar a foto de um produto não mexe na de outro.
      async subirFoto(arquivo) {
        const { blob } = await encolherFoto(arquivo);
        const nome = ctx.cliente.id + "/" +
          Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ".jpg";

        const { error } = await sb.storage.from("cardapio")
          .upload(nome, blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw error;

        const { data } = sb.storage.from("cardapio").getPublicUrl(nome);
        return data.publicUrl;
      },

      // Manda um arquivo de propaganda. Diferente da foto do cardápio,
      // aqui NÃO dá para encolher no navegador: vídeo o navegador não
      // recodifica. Vai como veio — daí o aviso de tamanho na tela.
      //
      // cacheControl de um ano: o nome é sorteado e nunca se repete, então
      // guardar por muito tempo é seguro. Isso poupa MUITO tráfego —
      // dezessete tablets rebaixando vídeo o dia inteiro sairia caro.
      async subirPropaganda(arquivo) {
        const ext = (String(arquivo.name || "").match(/\.([a-z0-9]+)$/i) || [, "bin"])[1].toLowerCase();
        const nome = ctx.cliente.id + "/" +
          Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext;

        const { error } = await sb.storage.from("propaganda").upload(nome, arquivo, {
          contentType: arquivo.type || "application/octet-stream",
          cacheControl: "31536000",
          upsert: false,
        });
        if (error) throw error;

        const { data } = sb.storage.from("propaganda").getPublicUrl(nome);
        return data.publicUrl;
      },

      async apagarPropaganda(url) {
        const m = String(url || "").match(/\/storage\/v1\/object\/public\/propaganda\/(.+)$/);
        if (!m) return false;
        const { error } = await sb.storage.from("propaganda")
          .remove([decodeURIComponent(m[1].split("?")[0])]);
        if (error) { console.warn("Apagar propaganda:", error); return false; }
        return true;
      },

      // Apaga uma foto que este app subiu. Endereço de fora (alguém colou
      // um link) passa batido de propósito — não é nosso para apagar.
      async apagarFoto(url) {
        const caminho = caminhoDaFoto(url);
        if (!caminho) return false;
        const { error } = await sb.storage.from("cardapio").remove([caminho]);
        if (error) { console.warn("Apagar foto:", error); return false; }
        return true;
      },

      async disponibilidade(produtoId, disponivel) {
        return ok(sb.rpc("set_product_availability", { p_id: produtoId, p_available: disponivel }));
      },

      async salvar(tabela, linha) {
        const t = TABELAS[tabela] || tabela;
        const corpo = Object.assign({}, linha);
        if (!corpo.tenant_id) corpo.tenant_id = ctx.cliente.id;
        if (corpo.id) {
          const id = corpo.id; delete corpo.id;
          return ok(sb.from(t).update(corpo).eq("id", id).select().single());
        }
        return ok(sb.from(t).insert(corpo).select().single());
      },

      async remover(tabela, id) {
        const t = TABELAS[tabela] || tabela;
        return ok(sb.from(t).delete().eq("id", id));
      },

      async reordenar(tabela, ids) {
        const t = TABELAS[tabela] || tabela;
        return ok(sb.rpc("reorder_rows", { p_table: t, p_ids: ids }));
      },

      async salvarCliente(campos) {
        return ok(sb.from("tenants").update(campos).eq("id", ctx.cliente.id).select().single());
      },

      async relatorio(view, filtros) {
        let q = sb.from(view).select("*");
        Object.keys(filtros || {}).forEach((k) => { q = q.eq(k, filtros[k]); });
        return ok(q);
      },

      escutar(aoMudarPedidos, aoMudarCatalogo) {
        const canal = sb.channel("pedidos-lagoa");
        ["orders", "order_items"].forEach((t) =>
          canal.on("postgres_changes", { event: "*", schema: "public", table: t }, aoMudarPedidos));
        ["products", "sections", "categories", "tips", "tenants", "kiosks"].forEach((t) =>
          canal.on("postgres_changes", { event: "*", schema: "public", table: t }, aoMudarCatalogo));
        canal.subscribe((estado) => {
          // CHANNEL_ERROR/TIMED_OUT = ficou sem tempo real. O app continua
          // funcionando: a recarga periódica cobre o buraco.
          if (estado === "SUBSCRIBED") marcarRede(true);
        });
        return canal;
      },
    };
  }

  // ==================================================================
  //  BANCO — versão PÚBLICA  (o cliente que escaneou o QR)
  //  ------------------------------------------------------------------
  //  Quem chega pelo adesivo do quiosque NÃO TEM LOGIN. Este backend fala
  //  com o banco por quatro funções públicas e mais nada — nem uma linha
  //  de tabela ele enxerga direto.
  //
  //  Por fora ele se comporta igual aos outros, de propósito: assim a
  //  tela do cardápio (quiosque.js) funciona sem saber quem está usando.
  // ==================================================================
  const CHAVE_MEUS_PUBLICOS = "pedidos_lagoa_meus_pedidos";

  function BackendPublico(url, chave, token) {
    const sb = window.supabase.createClient(url, chave, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let cardapio = null;   // o que veio do cardapio_publico

    async function ok(promessa) {
      const { data, error } = await promessa;
      if (error) throw error;
      return data;
    }

    // O banco devolve {erro: "..."} em vez de estourar, para a tela poder
    // explicar o que houve em português em vez de mostrar código.
    function conferir(d) {
      if (d && d.erro) {
        const e = new Error(d.mensagem || d.erro);
        e.codigo = d.erro;
        e.dados = d;
        throw e;
      }
      return d;
    }

    // Os ids dos próprios pedidos ficam no celular do cliente: é o que
    // permite acompanhar sem login. Guardamos o dia junto para a lista
    // não crescer para sempre.
    function meusIds() {
      try {
        const b = JSON.parse(localStorage.getItem(CHAVE_MEUS_PUBLICOS) || "[]");
        const ontem = Date.now() - 18 * 3600 * 1000;
        return (Array.isArray(b) ? b : [])
          .filter((x) => x && x.id && Number(x.em) > ontem)
          .slice(-30);
      } catch (e) { return []; }
    }
    function guardarId(id) {
      try {
        const lista = meusIds();
        lista.push({ id: id, em: Date.now() });
        localStorage.setItem(CHAVE_MEUS_PUBLICOS, JSON.stringify(lista.slice(-30)));
      } catch (e) { /* celular sem armazenamento: perde o acompanhamento, não o pedido */ }
    }

    return {
      tipo: "publico",
      sb: null,          // as telas de admin não existem aqui
      token: token,

      async sessao() {
        cardapio = conferir(await ok(sb.rpc("cardapio_publico", { p_token: token })));
        return {
          perfil: {
            id: "publico", role: "quiosque", display_name: cardapio.quiosque.name,
            tenant_id: cardapio.cliente.id, kiosk_id: cardapio.quiosque.id, active: true,
          },
          cliente: cardapio.cliente,
          quiosque: cardapio.quiosque,
        };
      },

      async entrar() { throw new Error("Esta tela não usa senha."); },
      async sair() { /* não há sessão para encerrar */ },

      async carregarCatalogo() {
        if (!cardapio) {
          cardapio = conferir(await ok(sb.rpc("cardapio_publico", { p_token: token })));
        }
        return {
          secoes: cardapio.secoes || [],
          categorias: cardapio.categorias || [],
          produtos: cardapio.produtos || [],
          dicas: cardapio.dicas || [],
          quiosques: [cardapio.quiosque],
        };
      },

      async carregarPedidos() {
        const ids = meusIds().map((x) => x.id);
        if (!ids.length) return [];
        const lista = await ok(sb.rpc("meus_pedidos_publicos", { p_ids: ids }));
        // a função pública devolve o essencial; completamos o que a tela espera
        return (lista || []).map((p) => Object.assign({
          kiosk_id: cardapio ? cardapio.quiosque.id : null,
          quiosque: cardapio ? cardapio.quiosque : null,
          itens: [], notes: null, customer_name: null, table_label: null,
        }, p));
      },

      async criarPedido(p) {
        const onde = await ondeEstou();
        const d = conferir(await ok(sb.rpc("pedido_publico", {
          p_token: token,
          p_items: p.itens,
          p_notes: p.observacao || null,
          p_customer_name: p.cliente || null,
          p_table_label: p.lugar || null,
          p_lat: onde.lat, p_lng: onde.lng, p_accuracy: onde.precisao,
        })));
        guardarId(d.id);
        return { id: d.id, daily_number: d.numero, total_cents: d.total_cents, items_count: d.itens };
      },

      async mudarStatus(id, status, motivo) {
        if (status !== "cancelado") {
          throw new Error("Só o atendente pode mudar isso.");
        }
        return conferir(await ok(sb.rpc("cancelar_pedido_publico", {
          p_id: id, p_token: token, p_motivo: motivo || null,
        })));
      },

      async marcarVistos() { return 0; },
      async fecharSessoes() { throw new Error("Sem permissão."); },
      async subirFoto() { throw new Error("Sem permissão."); },
      async subirPropaganda() { throw new Error("Sem permissão."); },
      async apagarPropaganda() { return false; },
      async apagarFoto() { return false; },
      async disponibilidade() { throw new Error("Sem permissão."); },
      async salvar() { throw new Error("Sem permissão."); },
      async remover() { throw new Error("Sem permissão."); },
      async reordenar() { throw new Error("Sem permissão."); },
      async salvarCliente() { throw new Error("Sem permissão."); },
      async relatorio() { return []; },

      // Sem login não há tempo real (o banco não deixa o visitante escutar
      // as tabelas, e com razão). A recarga periódica do núcleo cobre —
      // o cliente só precisa ver o próprio pedido mudar de estado.
      escutar() { return null; },
    };
  }

  // ==================================================================
  //  FOTO DO CARDÁPIO
  //  ------------------------------------------------------------------
  //  A foto sai do celular com vários MB e 4000 pixels de largura. Mandar
  //  isso para o cardápio seria ruim duas vezes: o upload demora no
  //  Wi-Fi da beira da lagoa, e depois CADA tablet baixa o arquivo inteiro
  //  para mostrar uma miniatura de 200 pixels.
  //
  //  Então o próprio aparelho encolhe antes de enviar. Medido aqui: uma
  //  imagem de 4032×3024 sai com 1200×900 e algumas centenas de KB (o pior
  //  caso, com ruído puro, deu 256 KB; foto de verdade fica bem abaixo).
  //  Leva cerca de 1,5 s num aparelho comum — daí o aviso na tela enquanto
  //  isso acontece.
  // ==================================================================
  const FOTO_LADO_MAX = 1200;   // px no maior lado
  const FOTO_QUALIDADE = 0.82;  // JPEG: acima disso o arquivo cresce sem ganho visível

  // O endereço público do Supabase termina em ".../cardapio/<caminho>".
  // Devolve só o <caminho> — e null se a foto não for nossa.
  function caminhoDaFoto(url) {
    const m = String(url || "").match(/\/storage\/v1\/object\/public\/cardapio\/(.+)$/);
    return m ? decodeURIComponent(m[1].split("?")[0]) : null;
  }

  function encolherFoto(arquivo, ladoMax) {
    const limite = ladoMax || FOTO_LADO_MAX;
    return new Promise((resolve, reject) => {
      if (!arquivo || !/^image\//.test(arquivo.type || "")) {
        return reject(new Error("Escolha um arquivo de imagem (JPG, PNG ou WEBP)."));
      }

      const url = URL.createObjectURL(arquivo);
      const img = new Image();

      img.onload = () => {
        try {
          let { width: l, height: a } = img;
          if (Math.max(l, a) > limite) {
            const fator = limite / Math.max(l, a);
            l = Math.round(l * fator);
            a = Math.round(a * fator);
          }
          const tela = document.createElement("canvas");
          tela.width = l; tela.height = a;
          const g = tela.getContext("2d");
          // fundo branco: PNG com transparência viraria preto no JPEG
          g.fillStyle = "#ffffff";
          g.fillRect(0, 0, l, a);
          g.drawImage(img, 0, 0, l, a);

          tela.toBlob((blob) => {
            URL.revokeObjectURL(url);
            if (!blob) return reject(new Error("Não consegui preparar a imagem."));
            resolve({ blob, largura: l, altura: a });
          }, "image/jpeg", FOTO_QUALIDADE);
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Não consegui abrir essa imagem. Tente outra foto."));
      };

      img.src = url;
    });
  }

  // Pergunta a localização ao celular. Devolve sempre — se a pessoa negar
  // ou o aparelho não souber, volta vazio e quem decide o que fazer é o
  // banco, que é onde a regra vale.
  function ondeEstou() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: null, lng: null, precisao: null });
      let respondeu = false;
      const pronto = (r) => { if (!respondeu) { respondeu = true; resolve(r); } };

      // 12 s: acima disso o cliente acha que travou. Melhor mandar sem a
      // coordenada e deixar o banco explicar do que ficar rodando à toa.
      setTimeout(() => pronto({ lat: null, lng: null, precisao: null }), 12000);

      navigator.geolocation.getCurrentPosition(
        (pos) => pronto({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          precisao: pos.coords.accuracy,
        }),
        () => pronto({ lat: null, lng: null, precisao: null }),
        { enableHighAccuracy: true, timeout: 11000, maximumAge: 30000 }
      );
    });
  }

  // ==================================================================
  //  BANCO — versão DEMONSTRAÇÃO (sem Supabase configurado)
  //  Serve para abrir o endereço e navegar por tudo antes do banco
  //  existir. Os dados ficam só neste aparelho e somem se limpar o
  //  navegador. Nenhuma tela sabe a diferença — a "conversa" é a mesma.
  // ==================================================================
  function BackendDemo() {
    const CHAVE = "pedidos_lagoa_demo_v1";
    const CLIENTE = {
      id: "demo-cliente", slug: "lagoa", name: CFG.marca || "Pedidos Lagoa",
      legal_name: CFG.estabelecimento || "Lagoa",
      primary_color: "#0E5C63", accent_color: "#F4A024",
      timezone: "America/Sao_Paulo", sla_warn_minutes: 5, sla_late_minutes: 12,
      currency: "BRL", settings: {},
    };

    const QUIOSQUES = [];
    for (let i = 1; i <= 17; i++) {
      QUIOSQUES.push({ id: "q" + i, tenant_id: CLIENTE.id, number: i, name: "Quiosque " + i, active: true, sort_order: i });
    }

    const SECOES = [
      { id: "s1", tenant_id: CLIENTE.id, key: "comida", label: "Cardápio de Comida", icon: "🍽️", kind: "catalog", sort_order: 1, active: true },
      { id: "s2", tenant_id: CLIENTE.id, key: "pesca",  label: "Cardápio de Pesca",  icon: "🎣", kind: "catalog", sort_order: 2, active: true },
      { id: "s3", tenant_id: CLIENTE.id, key: "dicas",  label: "Dicas do Quiosque",  icon: "💡", kind: "tips",    sort_order: 3, active: true },
    ];

    const CATS = [
      ["c1", "s1", "Porções", 1], ["c2", "s1", "Lanches", 2], ["c3", "s1", "Bebidas", 3],
      ["c4", "s2", "Iscas", 1], ["c5", "s2", "Aluguel", 2], ["c6", "s2", "Acessórios", 3],
    ].map((c) => ({ id: c[0], tenant_id: CLIENTE.id, section_id: c[1], name: c[2], sort_order: c[3], active: true }));

    const PRODS = [
      ["p1", "s1", "c1", "Porção de tilápia frita", "Serve 2 pessoas, acompanha limão", 6500, "porção"],
      ["p2", "s1", "c1", "Batata frita", "Serve 2 pessoas", 3200, "porção"],
      ["p3", "s1", "c1", "Frango a passarinho", "", 4500, "porção"],
      ["p4", "s1", "c2", "X-Salada", "Hambúrguer, queijo, alface e tomate", 2400, "un"],
      ["p5", "s1", "c2", "Misto quente", "", 1400, "un"],
      ["p6", "s1", "c3", "Água mineral 500ml", "", 500, "un"],
      ["p7", "s1", "c3", "Refrigerante lata", "", 700, "un"],
      ["p8", "s1", "c3", "Cerveja lata", "", 900, "un"],
      ["p9", "s1", "c3", "Água de coco", "", 900, "un"],
      ["p10", "s2", "c4", "Minhoca", "Caixinha", 1000, "cx"],
      ["p11", "s2", "c4", "Massa para tilápia", "Pote 100g", 1500, "pote"],
      ["p12", "s2", "c5", "Vara de pesca (diária)", "Vara + molinete", 3000, "diária"],
      ["p13", "s2", "c5", "Cadeira de pesca", "", 1000, "diária"],
      ["p14", "s2", "c5", "Guarda-sol", "", 2000, "diária"],
      ["p15", "s2", "c6", "Anzol (cartela)", "Numeração variada", 500, "cartela"],
      ["p16", "s2", "c6", "Linha de nylon", "Carretel 100m", 1200, "un"],
    ].map((p, i) => ({
      id: p[0], tenant_id: CLIENTE.id, section_id: p[1], category_id: p[2],
      name: p[3], description: p[4], price_cents: p[5], unit: p[6],
      available: true, active: true, sort_order: i + 1, image_url: null,
    }));

    const DICAS = [
      ["d1", "Melhor horário para pescar", "O peixe come melhor no começo da manhã (6h às 9h) e no fim da tarde (16h às 18h30). No calor do meio-dia ele desce para o fundo — use chumbada mais pesada.", true],
      ["d2", "Peixes da lagoa", "Tilápia, traíra, cará e bagre. A tilápia pega bem com massa e milho; a traíra prefere isca viva.", false],
      ["d3", "Regras da pescaria", "Pesque só na área sinalizada. Devolva à água os peixes abaixo de 20 cm.", false],
      ["d4", "Wi-Fi e chuveiro", "A senha do Wi-Fi fica no balcão da recepção. Chuveiros ficam ao lado do quiosque 9.", false],
    ].map((d, i) => ({
      id: d[0], tenant_id: CLIENTE.id, section_id: "s3", kiosk_id: null,
      title: d[1], body: d[2], pinned: d[3], sort_order: i + 1, active: true, image_url: null,
    }));

    const PERFIS = {
      adm:      { role: "admin",    display_name: "Administrador", kiosk: null },
      recepcao: { role: "recepcao", display_name: "Recepção",      kiosk: null },
    };
    QUIOSQUES.forEach((q) => {
      PERFIS["quiosque" + q.number] = { role: "quiosque", display_name: q.name, kiosk: q };
    });

    function ler() {
      try {
        const b = JSON.parse(localStorage.getItem(CHAVE) || "{}");
        return {
          secoes: b.secoes || SECOES, categorias: b.categorias || CATS,
          produtos: b.produtos || PRODS, dicas: b.dicas || DICAS,
          quiosques: b.quiosques || QUIOSQUES, propagandas: b.propagandas || [],
          pedidos: b.pedidos || [],
          cliente: b.cliente || CLIENTE, login: b.login || null, contador: b.contador || 0,
        };
      } catch (e) {
        return { secoes: SECOES, categorias: CATS, produtos: PRODS, dicas: DICAS,
                 quiosques: QUIOSQUES, propagandas: [], pedidos: [],
                 cliente: CLIENTE, login: null, contador: 0 };
      }
    }
    function gravar(b) {
      try { localStorage.setItem(CHAVE, JSON.stringify(b)); } catch (e) {}
      // avisa as outras abas abertas neste mesmo aparelho
      try { canalDemo && canalDemo.postMessage("mudou"); } catch (e) {}
    }
    let canalDemo = null;
    let avisar = null;

    function contexto(b) {
      const p = PERFIS[b.login];
      if (!p) return null;
      return {
        perfil: { id: "demo-" + b.login, role: p.role, display_name: p.display_name,
                  tenant_id: b.cliente.id, kiosk_id: p.kiosk ? p.kiosk.id : null, active: true },
        cliente: b.cliente,
        quiosque: p.kiosk,
      };
    }

    function novaId() { return "x" + Math.random().toString(36).slice(2, 10); }

    // Os mesmos carimbos que o trigger tg_orders_stamp faz no banco.
    function aplicarStatus(p, status, motivo) {
      const agora = new Date().toISOString();
      p.status = status;
      p.updated_at = agora;
      if (!p.ack_at && status !== "recebido") p.ack_at = agora;
      if (status === "lancado" && !p.launched_at) p.launched_at = agora;
      if (FECHADOS.indexOf(status) >= 0) p.closed_at = p.closed_at || agora;
      else p.closed_at = null;
      if (status === "erro" || status === "cancelado") p.error_reason = motivo || null;
    }

    return {
      tipo: "demo",
      sb: null,

      async sessao() { const b = ler(); return b.login ? contexto(b) : null; },

      async entrar(email) {
        const login = String(email).split("@")[0].toLowerCase();
        if (!PERFIS[login]) {
          throw new Error("No modo demonstração os usuários são: adm, recepcao e quiosque1 a quiosque17.");
        }
        const b = ler(); b.login = login; gravar(b);
        return contexto(b);
      },

      async sair() { const b = ler(); b.login = null; gravar(b); },

      async carregarCatalogo() {
        const b = ler();
        return { secoes: b.secoes, categorias: b.categorias, produtos: b.produtos,
                 dicas: b.dicas, quiosques: b.quiosques, propagandas: b.propagandas };
      },

      // A mesma filtragem que a RLS faz no banco de verdade. Copiar essa
      // regra aqui é chato, mas é o que garante que a demonstração não
      // mostre a um perfil algo que no banco ele não veria.
      async carregarPedidos(dia) {
        const b = ler();
        const meu = contexto(b);
        let lista = b.pedidos.filter((p) => p.service_date === dia);
        if (meu && meu.perfil.role === "quiosque") {
          lista = lista.filter((p) => p.kiosk_id === meu.perfil.kiosk_id);
        }
        return lista.sort((a, x) => new Date(x.created_at) - new Date(a.created_at));
      },

      async criarPedido(p) {
        const b = ler();
        const meu = contexto(b);
        const quiosqueId = meu.perfil.role === "quiosque" ? meu.perfil.kiosk_id : (p.quiosqueId || meu.perfil.kiosk_id);
        const q = b.quiosques.find((k) => k.id === quiosqueId);
        if (!q) throw new Error("Escolha o quiosque.");

        const dia = hojeNoFuso(b.cliente.timezone);
        const doDia = b.pedidos.filter((x) => x.service_date === dia);
        const agora = new Date().toISOString();
        const pedidoId = novaId();

        const itens = (p.itens || []).map((it) => {
          const prod = b.produtos.find((x) => x.id === it.product_id);
          if (!prod) throw new Error("Produto não encontrado.");
          if (prod.available === false || prod.active === false) {
            throw new Error("O item " + prod.name + " saiu do cardápio.");
          }
          const secao = b.secoes.find((s) => s.id === prod.section_id) || {};
          const qtd = Math.max(1, Number(it.qty) || 1);
          return {
            id: novaId(), order_id: pedidoId, product_id: prod.id, product_name: prod.name,
            section_key: secao.key,
            unit_price_cents: prod.price_cents, qty: qtd,
            line_total_cents: prod.price_cents * qtd, notes: it.notes || null,
          };
        });
        if (!itens.length) throw new Error("Pedido sem itens.");

        const pedido = {
          id: pedidoId, tenant_id: b.cliente.id, kiosk_id: q.id,
          daily_number: doDia.length + 1, service_date: dia, status: "recebido",
          customer_name: p.cliente || null, table_label: p.lugar || null, notes: p.observacao || null,
          items_count: itens.reduce((s, i) => s + i.qty, 0),
          total_cents: itens.reduce((s, i) => s + i.line_total_cents, 0),
          created_at: agora, updated_at: agora,
          ack_at: null, launched_at: null, closed_at: null, error_reason: null,
          quiosque: { id: q.id, number: q.number, name: q.name },
          itens: itens,
        };

        b.pedidos.push(pedido);
        gravar(b);
        if (avisar) setTimeout(avisar, 30);
        return pedido;
      },

      async mudarStatus(id, status, motivo) {
        const b = ler();
        const meu = contexto(b);
        const p = b.pedidos.find((x) => x.id === id);
        if (!p) throw new Error("Pedido não encontrado.");

        if ((status === "erro" || status === "cancelado") && !String(motivo || "").trim()) {
          throw new Error("Informe o motivo.");
        }
        // o quiosque só desiste antes de a recepção lançar
        if (meu && meu.perfil.role === "quiosque" && p.status !== "recebido") {
          throw new Error("A recepção já lançou este pedido. Fale com ela.");
        }

        aplicarStatus(p, status, motivo);
        gravar(b);
        if (avisar) setTimeout(avisar, 30);
        return p;
      },

      async marcarVistos(ids) {
        const b = ler();
        (ids || []).forEach((id) => {
          const p = b.pedidos.find((x) => x.id === id);
          if (p && !p.ack_at) p.ack_at = new Date().toISOString();
        });
        gravar(b);
        return (ids || []).length;
      },

      async fecharSessoes(ids) {
        const b = ler();
        const agora = new Date().toISOString();
        (ids || []).forEach((id) => {
          const k = b.quiosques.find((x) => x.id === id);
          if (k) k.session_started_at = agora;
        });
        gravar(b);
        return (ids || []).length;
      },

      // Sem nuvem a propaganda também vira um endereço "data:" aqui mesmo.
      // Vídeo estoura o armazenamento do navegador num arquivo só, então
      // na demonstração só imagem entra — e o recado diz isso.
      async subirPropaganda(arquivo) {
        if (!/^image\//.test((arquivo && arquivo.type) || "")) {
          throw new Error("No modo demonstração só dá para usar imagem, não vídeo.");
        }
        return this.subirFoto(arquivo);
      },

      async apagarPropaganda() { return false; },

      // Sem nuvem, a foto vira um endereco "data:" guardado aqui mesmo.
      // Encolhemos mais que no modo nuvem porque o armazenamento do
      // navegador e pequeno (uns 5 MB no total).
      async subirFoto(arquivo) {
        const { blob } = await encolherFoto(arquivo, 700);
        return await new Promise((resolve, reject) => {
          const leitor = new FileReader();
          leitor.onload = () => resolve(leitor.result);
          leitor.onerror = () => reject(new Error("Nao consegui ler a imagem."));
          leitor.readAsDataURL(blob);
        });
      },

      async apagarFoto() { return false; },

      async disponibilidade(produtoId, disponivel) {
        const b = ler();
        const p = b.produtos.find((x) => x.id === produtoId);
        if (p) { p.available = disponivel; gravar(b); }
        return p;
      },

      async salvar(tabela, linha) {
        const b = ler();
        const lista = b[tabela];
        if (!lista) throw new Error("Tabela desconhecida: " + tabela);
        if (linha.id) {
          const i = lista.findIndex((x) => x.id === linha.id);
          if (i < 0) throw new Error("Registro não encontrado.");
          lista[i] = Object.assign({}, lista[i], linha);
          gravar(b); return lista[i];
        }
        const nova = Object.assign(
          { id: novaId(), tenant_id: b.cliente.id, active: true, sort_order: lista.length + 1 },
          linha
        );
        lista.push(nova); gravar(b); return nova;
      },

      async remover(tabela, id) {
        const b = ler();
        const lista = b[tabela];
        if (!lista) throw new Error("Tabela desconhecida: " + tabela);
        const i = lista.findIndex((x) => x.id === id);
        if (i >= 0) lista.splice(i, 1);
        gravar(b);
      },

      async reordenar(tabela, ids) {
        const b = ler();
        const lista = b[tabela] || [];
        ids.forEach((id, i) => {
          const r = lista.find((x) => x.id === id);
          if (r) r.sort_order = i + 1;
        });
        gravar(b);
      },

      async salvarCliente(campos) {
        const b = ler();
        b.cliente = Object.assign({}, b.cliente, campos);
        gravar(b);
        return b.cliente;
      },

      async relatorio() { return []; },

      // "Tempo real" de mentira: só avisa as outras abas do mesmo aparelho.
      escutar(aoMudarPedidos) {
        avisar = aoMudarPedidos;
        try {
          canalDemo = new BroadcastChannel("pedidos_lagoa_demo");
          canalDemo.onmessage = () => aoMudarPedidos();
        } catch (e) { /* navegador antigo: fica só com a recarga periódica */ }
        return canalDemo;
      },

      // Usado pela engrenagem para começar do zero na demonstração.
      limpar() { try { localStorage.removeItem(CHAVE); } catch (e) {} },
    };
  }

  // ==================================================================
  //  OS DOIS TIPOS DE LINK DO QUIOSQUE
  //  ------------------------------------------------------------------
  //  ?k=<codigo>  → É O ADESIVO DO BALCÃO, para o CLIENTE.
  //                 Abre o cardápio direto, sem senha nenhuma. Quem
  //                 garante que a pessoa está no local é a localização,
  //                 conferida no banco na hora de enviar o pedido.
  //
  //  ?q=<numero>  → Atalho para a EQUIPE montar um tablet. Não entra
  //                 sozinho: só preenche o usuário na tela de login.
  //
  //  Nenhum dos dois carrega senha. Um QR com senha dentro seria a chave
  //  do sistema pendurada na parede.
  // ==================================================================
  let quiosqueDoLink = null;   // número lido do ?q= (atalho da equipe)
  let tokenDoLink = null;      // código lido do ?k= (adesivo do cliente)

  function parametroDoEndereco(nome) {
    try {
      const busca = new URLSearchParams(location.search);
      let v = busca.get(nome);
      if (!v) {
        // alguns leitores de QR jogam os parâmetros para depois do "#"
        const h = String(location.hash || "");
        const i = h.indexOf("?");
        if (i >= 0) v = new URLSearchParams(h.slice(i + 1)).get(nome);
      }
      return v || null;
    } catch (e) { return null; }
  }

  function lerQuiosqueDoEndereco() {
    const n = parseInt(parametroDoEndereco("q") || parametroDoEndereco("quiosque"), 10);
    return n > 0 && n < 1000 ? n : null;
  }

  function lerTokenDoEndereco() {
    const t = String(parametroDoEndereco("k") || "").trim();
    return /^[a-z0-9]{6,32}$/i.test(t) ? t : null;
  }

  // Os endereços que vão dentro dos QR codes. Saem do endereço atual, então
  // funcionam igual em github.io/pedidos_lagoa/ e num domínio próprio — sem
  // ninguém ter que configurar nada.
  function enderecoBase() {
    return location.origin + location.pathname.replace(/index\.html$/i, "");
  }
  function enderecoDoCliente(token) {
    return enderecoBase() + "?k=" + encodeURIComponent(token);
  }
  function enderecoDoQuiosque(numero) {
    return enderecoBase() + "?q=" + encodeURIComponent(numero);
  }

  // ==================================================================
  //  LOGIN
  // ==================================================================
  // O Supabase só aceita E-MAIL, mas ninguém no quiosque quer digitar
  // e-mail. Quem escrever "quiosque7" vira "quiosque7@pedidoslagoa.local".
  // Quem escrever o e-mail inteiro (com "@") passa como está.
  function emailDoUsuario(txt) {
    const t = String(txt || "").trim();
    if (t.indexOf("@") >= 0) return t.toLowerCase();
    const limpo = t.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // recepção -> recepcao
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9._-]/g, "");
    return limpo + "@" + (CFG.dominioLogin || "pedidoslagoa.local");
  }

  function senhaCompleta(senha) {
    const s = String(senha || "");
    const suf = String(CFG.sufixoSenha || "");
    return (s.length >= 6 && !suf) ? s : s + suf;
  }

  function montarLogin() {
    const form = $("#loginForm");
    const msg = $("#loginMsg");
    const btn = $("#loginBtn");

    const dicas = $("#loginDicas");
    const lista = Array.isArray(CFG.atalhosLogin) ? CFG.atalhosLogin : [];
    if (dicas && lista.length) {
      dicas.innerHTML = lista.map((u) =>
        `<button type="button" class="login-dica" data-u="${esc(u)}">${esc(u)}</button>`).join("");
      dicas.addEventListener("click", (e) => {
        const b = e.target.closest("[data-u]");
        if (!b) return;
        $("#loginUsuario").value = b.dataset.u;
        $("#loginSenha").focus();
      });
    }

    // Veio pelo QR do quiosque: o usuário já entra preenchido e o cursor
    // cai direto na senha. É o que faz o QR valer a pena — ninguém digita
    // "quiosque14" num tablet molhado.
    if (quiosqueDoLink) {
      const campoUsuario = $("#loginUsuario");
      if (campoUsuario) campoUsuario.value = "quiosque" + quiosqueDoLink;
      const sub = $("#loginSub");
      if (sub) sub.textContent = "Quiosque " + quiosqueDoLink + " — digite a senha";
      if (dicas) dicas.hidden = true;
    }

    const rodape = $("#loginRodape");
    if (rodape) {
      rodape.innerHTML = backend.tipo === "demo"
        ? "<b>Modo demonstração.</b> Entre com <b>adm</b>, <b>recepcao</b> ou <b>quiosque1</b>…<b>quiosque17</b> — a senha pode ser qualquer coisa. Os dados ficam só neste aparelho."
        : "Esqueceu a senha? Peça para o administrador rodar o <b>06-usuarios.sql</b> de novo com a senha nova.";
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const usuario = $("#loginUsuario").value.trim();
      const senha = $("#loginSenha").value;
      if (!usuario) return;

      btn.disabled = true;
      btn.textContent = "Entrando…";
      msg.className = "form-msg";
      msg.textContent = "";
      try {
        ctx = await backend.entrar(emailDoUsuario(usuario), senhaCompleta(senha));
        $("#loginSenha").value = "";
        await abrirApp();
      } catch (err) {
        msg.textContent = erroLegivel(err);
        $("#loginSenha").select();
      } finally {
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }

  async function sair() {
    const certeza = await confirmar({
      titulo: "Sair do aplicativo",
      texto: "Este tablet vai precisar do usuário e da senha para entrar de novo. Quer mesmo sair?",
      ok: "Sair", perigo: true,
    });
    if (!certeza) return;
    await backend.sair();
    location.reload();
  }

  // ==================================================================
  //  TELAS  (cada arquivo registra as suas)
  // ==================================================================
  function registrarTela(def) {
    telas.push(Object.assign({
      id: "", rotulo: "", icone: "", papeis: [], ordem: 50,
      montar: null, aoEntrar: null, aoSair: null, engrenagem: null,
    }, def));
    telas.sort((a, b) => a.ordem - b.ordem);
  }

  function telasDoPapel() {
    const papel = ctx && ctx.perfil ? ctx.perfil.role : null;
    return telas.filter((t) => !t.papeis.length || t.papeis.indexOf(papel) >= 0);
  }

  function desenharBotoesDeTela() {
    const caixa = $("#telasBtns");
    const lista = telasDoPapel();
    caixa.innerHTML = lista.map((t) =>
      `<button class="vs-btn" role="tab" data-tela="${esc(t.id)}">${esc(t.rotulo)}</button>`).join("");
    caixa.hidden = lista.length < 2;
    caixa.onclick = (e) => {
      const b = e.target.closest("[data-tela]");
      if (b) irPara(b.dataset.tela);
    };
  }

  function irPara(id, forcar) {
    const lista = telasDoPapel();
    const tela = lista.find((t) => t.id === id) || lista[0];
    if (!tela) return;
    if (telaAtiva && telaAtiva.id === tela.id && !forcar) return;

    if (telaAtiva && telaAtiva.aoSair) {
      try { telaAtiva.aoSair(); } catch (e) { console.error(e); }
    }

    telaAtiva = tela;
    const alvo = $("#conteudo");
    alvo.innerHTML = "";
    $("#rodapeFixo").innerHTML = "";

    $$("#telasBtns .vs-btn").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tela === tela.id));

    // O ⚙ da barra de cima muda de dono conforme a tela: cada tela diz o
    // que ele configura. É isso que dá ao admin a "engrenagem daquela aba".
    const bt = $("#cfgTelaBtn");
    if (bt) {
      const pode = ehAdmin() && typeof tela.engrenagem === "function";
      bt.hidden = !pode;
      bt.title = "Configurar: " + tela.rotulo;
      bt.onclick = pode ? () => tela.engrenagem() : null;
    }

    try {
      if (tela.montar) tela.montar(alvo);
      if (tela.aoEntrar) tela.aoEntrar();
    } catch (e) {
      console.error("Erro ao abrir a tela " + tela.id, e);
      alvo.innerHTML = `<div class="aviso aviso-erro">Não consegui abrir esta tela. ${esc(erroLegivel(e))}</div>`;
    }

    try { history.replaceState(null, "", "#/" + tela.id); } catch (e) {}
  }

  function recarregarTela() {
    if (telaAtiva) irPara(telaAtiva.id, true);
  }

  // ==================================================================
  //  DADOS EM MEMÓRIA
  // ==================================================================
  async function recarregarCatalogo() {
    catalogo = await backend.carregarCatalogo();
    emitir("catalogo", catalogo);
    return catalogo;
  }

  let primeiraCargaDePedidos = true;

  async function recarregarPedidos() {
    const dia = hojeNoFuso(ctx && ctx.cliente ? ctx.cliente.timezone : null);
    const novos = await backend.carregarPedidos(dia);

    // Descobre se chegou pedido NOVO (para tocar o aviso na recepção).
    // Na PRIMEIRA carga ninguém "chegou": senão o tablet tocaria o alarme
    // para a fila inteira só por ter sido ligado de manhã.
    const antes = new Set(pedidos.map((p) => p.id));
    const chegaram = primeiraCargaDePedidos
      ? []
      : novos.filter((p) => !antes.has(p.id) && p.status === "recebido");
    primeiraCargaDePedidos = false;

    pedidos = novos;
    emitir("pedidos", { pedidos, chegaram });
    return pedidos;
  }

  // Recarrega sem deixar duas chamadas se atropelarem: o tempo real
  // dispara um aviso por linha alterada, e um pedido com 6 itens geraria
  // 7 recargas seguidas.
  const recarregarPedidosSuave = adiar(() => {
    recarregarPedidos().catch((e) => console.warn("Recarga:", e));
  }, 350);

  const recarregarCatalogoSuave = adiar(() => {
    recarregarCatalogo().then(() => recarregarTela()).catch((e) => console.warn("Catálogo:", e));
  }, 600);

  // ==================================================================
  //  ESTADO DA CONEXÃO
  // ==================================================================
  function marcarRede(ok) {
    if (semRede === !ok) return;
    semRede = !ok;
    desenharFaixa();
  }

  function desenharFaixa() {
    const f = $("#faixaEstado");
    if (!f) return;
    if (semRede) {
      f.hidden = false; f.className = "faixa-topo off";
      f.textContent = "⚠ Sem internet — os pedidos podem não chegar. Confira o Wi-Fi.";
    } else if (backend && backend.tipo === "demo") {
      f.hidden = false; f.className = "faixa-topo demo";
      f.textContent = "MODO DEMONSTRAÇÃO — os dados ficam só neste aparelho. Preencha o config.js para ligar no banco.";
    } else {
      f.hidden = true;
    }
  }

  window.addEventListener("online",  () => { marcarRede(true); recarregarPedidosSuave(); });
  window.addEventListener("offline", () => marcarRede(false));

  // ==================================================================
  //  PAPÉIS
  // ==================================================================
  function papel()      { return ctx && ctx.perfil ? ctx.perfil.role : null; }
  function ehAdmin()    { return papel() === "admin"; }
  function ehRecepcao() { return papel() === "recepcao"; }
  function ehQuiosque() { return papel() === "quiosque"; }
  function ehEquipe()   { return ehAdmin() || ehRecepcao(); }
  // "público" = o cliente que chegou pelo adesivo, sem login. Ele usa a
  // mesma tela de cardápio do quiosque, mas não tem botão de sair, não
  // tem engrenagem e não enxerga pedido de mais ninguém.
  function ehPublico()  { return !!backend && backend.tipo === "publico"; }

  // ==================================================================
  //  ABRIR O APP (depois do login)
  // ==================================================================
  async function abrirApp() {
    $("#loginScreen").hidden = true;
    $("#app").hidden = false;

    aplicarTema(ctx.cliente);
    desenharFaixa();

    // quem está usando este tablet
    const q = $("#quemSou");
    if (q) {
      q.hidden = false;
      q.innerHTML = ctx.quiosque
        ? `📍 <b>${esc(ctx.quiosque.name)}</b>`
        : `<b>${esc(ctx.perfil.display_name)}</b> <small>${esc(rotuloPapel(ctx.perfil.role))}</small>`;
    }
    // O cliente do QR não tem sessão para encerrar — um botão "Sair" só o
    // deixaria preso numa tela de login que ele não pode preencher.
    $("#sairBtn").hidden = ehPublico();
    $("#sairBtn").onclick = sair;

    // a engrenagem geral (🛠) é só do admin
    const geral = $("#cfgGeralBtn");
    if (geral) {
      geral.hidden = !ehAdmin();
      geral.onclick = () => emitir("abrir-config-geral");
    }

    $("#conteudo").innerHTML = '<div class="carregando"><span class="girando"></span> Carregando o cardápio…</div>';

    try {
      await recarregarCatalogo();
      await recarregarPedidos();
    } catch (e) {
      console.error(e);
      $("#conteudo").innerHTML =
        `<div class="aviso aviso-erro">Não consegui carregar os dados. ${esc(erroLegivel(e))}</div>`;
      return;
    }

    desenharBotoesDeTela();

    // tempo real + uma recarga de segurança a cada 45 s (se o tempo real
    // cair, ninguém percebe: os pedidos continuam aparecendo)
    backend.escutar(recarregarPedidosSuave, recarregarCatalogoSuave);
    setInterval(() => {
      if (document.visibilityState === "visible") recarregarPedidosSuave();
    }, 45000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recarregarPedidosSuave();
    });

    // O relógio dos cartões ("há 7 min") precisa andar mesmo sem nada
    // mudar no banco.
    setInterval(() => emitir("tique"), 20000);

    // Tablet do quiosque: tela sempre acesa. A permissão se perde quando o
    // app sai da frente, então pedimos de novo toda vez que ele volta.
    cuidarDaTelaAcesa();
    document.addEventListener("visibilitychange", cuidarDaTelaAcesa);

    const doHash = (location.hash || "").replace("#/", "");
    irPara(doHash || telaInicial());

    // Avisa que o app está de pé e o perfil já é conhecido. A propaganda
    // espera por isto: antes do login ela não teria como saber se estamos
    // num tablet de quiosque ou no celular de um cliente.
    emitir("pronto", ctx);
  }

  function telaInicial() {
    const lista = telasDoPapel();
    return lista.length ? lista[0].id : "";
  }

  function rotuloPapel(r) {
    return { admin: "Administrador", recepcao: "Recepção", quiosque: "Quiosque" }[r] || r;
  }

  // ==================================================================
  //  PARTIDA
  // ==================================================================
  async function iniciar() {
    registrarServiceWorker();
    quiosqueDoLink = lerQuiosqueDoEndereco();
    tokenDoLink = lerTokenDoEndereco();

    // marca inicial (antes de saber quem é o cliente na nuvem)
    aplicarTema({ name: CFG.marca, legal_name: CFG.estabelecimento });

    const temSupabase = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase;

    // ---- veio pelo adesivo do balcão: o cliente entra direto ----
    if (tokenDoLink && temSupabase) {
      backend = BackendPublico(CFG.supabaseUrl, CFG.supabaseAnonKey, tokenDoLink);
      PL.backend = backend;
      PL.demo = false;
      desenharFaixa();
      try {
        ctx = await backend.sessao();
        await abrirApp();
        return;
      } catch (e) {
        // QR velho, quiosque desativado, pedido público desligado: a pessoa
        // precisa entender o que houve, e não ver uma tela de login que ela
        // não tem como preencher.
        console.warn("QR público:", e);
        mostrarRecadoDeQrInvalido(e);
        return;
      }
    }

    backend = temSupabase
      ? BackendSupabase(CFG.supabaseUrl, CFG.supabaseAnonKey)
      : BackendDemo();
    PL.backend = backend;
    PL.demo = backend.tipo === "demo";

    montarLogin();
    desenharFaixa();

    let sessao = null;
    try { sessao = await backend.sessao(); }
    catch (e) { console.warn("Sessão:", e); }

    if (sessao) {
      ctx = sessao;
      await abrirApp();
    } else {
      $("#loginScreen").hidden = false;
      // vindo do atalho da equipe o usuário já está escrito: o dedo vai
      // direto para a senha
      const campo = quiosqueDoLink ? "#loginSenha" : "#loginUsuario";
      setTimeout(() => { const c = $(campo); if (c) c.focus(); }, 120);
    }
  }

  // Tela de recado para quem escaneou um QR que não vale mais. Sem botão de
  // login: quem chegou pelo adesivo não tem senha para digitar, e oferecer
  // um formulário impossível de preencher só piora.
  function mostrarRecadoDeQrInvalido(erro) {
    const tela = $("#loginScreen");
    if (!tela) return;
    tela.hidden = false;
    tela.innerHTML =
      '<div class="login-box">' +
        '<div style="font-size:3rem;line-height:1">📷</div>' +
        '<h1 class="login-tit">QR code fora do ar</h1>' +
        '<p style="color:var(--muted);line-height:1.6;margin:12px 0 0">' +
          esc(erroLegivel(erro)) +
        "</p>" +
        '<p style="color:var(--muted);line-height:1.6;margin:14px 0 0">' +
          "Chame o atendente do quiosque — ele faz o pedido para você." +
        "</p>" +
        '<button type="button" class="btn btn-primary btn-big" style="margin-top:18px" ' +
          'onclick="location.reload()">Tentar de novo</button>' +
      "</div>";
  }

  function registrarServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // O caminho é relativo de propósito: assim funciona tanto em
    // usuario.github.io/pedidos_lagoa/ quanto num domínio próprio.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW:", e));
    });
  }

  // ==================================================================
  //  O QUE AS TELAS PODEM USAR
  // ==================================================================
  const PL = {
    VERSAO, CFG, STATUS, ABERTOS, FECHADOS, TABELAS,

    // atalhos
    $, $$, esc, dinheiro, minutosDesde, tempoCurto, hora, hojeNoFuso, aguarde, adiar,

    // a conta aberta de cada quiosque (o "turno")
    inicioDaSessao, pedidosDaSessao, horaDeEncerrar,
    minutosDaHora, relogioDaCasa,

    // links do QR code (ver "OS DOIS TIPOS DE LINK DO QUIOSQUE")
    get quiosqueDoLink() { return quiosqueDoLink; },
    get tokenDoLink() { return tokenDoLink; },
    enderecoDoQuiosque, enderecoDoCliente,
    ondeEstou,

    // avisos e pop-ups
    aviso, modal, confirmar, erroLegivel, tocarAviso, vibrar,

    // quem sou eu
    get ctx() { return ctx; },
    papel, ehAdmin, ehRecepcao, ehQuiosque, ehEquipe, ehPublico,

    // dados
    get catalogo() { return catalogo; },
    get pedidos() { return pedidos; },
    recarregarCatalogo, recarregarPedidos,
    get backend() { return backend; },
    set backend(b) { backend = b; },
    demo: false,

    // telas
    registrarTela, irPara, recarregarTela,
    get telaAtiva() { return telaAtiva; },

    // eventos
    ao, emitir,

    // tema (a engrenagem chama depois de salvar as cores)
    aplicarTema,

    iniciar,
  };

  window.PL = PL;
})();
